import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  runPostDeployApplicationSmoke,
} from "../../src/operations/post-deploy-application-smoke.js";

const databaseUrl = process.env.DATABASE_URL;
const deploymentRevision = process.env.PROOF_REVISION;
const whatsappSessionKey = process.env.WHATSAPP_SESSION_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!deploymentRevision) throw new Error("PROOF_REVISION is required");
if (!whatsappSessionKey) throw new Error("WHATSAPP_SESSION_KEY is required");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });

function requireFailure(
  report: Awaited<ReturnType<typeof runPostDeployApplicationSmoke>>,
  code: string,
) {
  if (report.passed || !report.failures.includes(code)) {
    throw new Error(`Application smoke did not fail closed with ${code}`);
  }
  if (
    report.providerLiveHealth !== "NOT_PROBED" ||
    report.finalPostDeploySmokeComplete !== false
  ) {
    throw new Error("Application smoke incorrectly claimed final/provider-live readiness");
  }
}

async function insertOutbox(status: "PENDING" | "DEAD", createdAtSql: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO outbox_messages(
       id, channel, destination_ref, message_type, payload, idempotency_key,
       status, attempts, created_at, correlation_id, causation_id
     ) VALUES ($1, 'WHATSAPP', 'proof-destination', 'TEXT', '{}'::jsonb, $2, $3, 0,
       ${createdAtSql}, $4, NULL)`,
    [id, `phase17-smoke-${id}`, status, randomUUID()],
  );
  return id;
}

async function markSent(id: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_messages
     SET status = 'SENT', sent_at = clock_timestamp(), last_error_code = NULL
     WHERE id = $1`,
    [id],
  );
}

try {
  const baseInput = {
    environment: "staging" as const,
    deploymentRevision,
    whatsappSessionKey,
  };

  const happy = await runPostDeployApplicationSmoke(pool, baseInput);
  if (!happy.passed) {
    throw new Error(
      `Prepared application smoke unexpectedly failed: ${happy.failures.join(",")}`,
    );
  }
  if (
    happy.providerLiveHealth !== "NOT_PROBED" ||
    happy.finalPostDeploySmokeComplete !== false
  ) {
    throw new Error("Application smoke must remain explicitly incomplete without a live provider probe");
  }
  if (
    happy.activeRelease?.releaseStatus !== "PUBLISHED" ||
    happy.activeRelease.rulesetStatus !== "PUBLISHED" ||
    happy.initialAdmin?.principalStatus !== "ACTIVE" ||
    !happy.initialAdmin.globalScopeActive ||
    !happy.whatsappSession.present
  ) {
    throw new Error("Happy-path application smoke evidence is incomplete");
  }

  const missingSession = await runPostDeployApplicationSmoke(pool, {
    ...baseInput,
    whatsappSessionKey: "definitely-missing-smoke-session",
  });
  requireFailure(missingSession, "WHATSAPP_SESSION_MISSING");

  const depthId = await insertOutbox("PENDING", "clock_timestamp()");
  const depth = await runPostDeployApplicationSmoke(pool, {
    ...baseInput,
    criticalQueueDepth: 1,
  });
  requireFailure(depth, "OUTBOX_CRITICAL_DEPTH");
  await markSent(depthId);

  const ageId = await insertOutbox(
    "PENDING",
    "clock_timestamp() - interval '10 minutes'",
  );
  const age = await runPostDeployApplicationSmoke(pool, baseInput);
  requireFailure(age, "OUTBOX_CRITICAL_AGE");
  await markSent(ageId);

  const deadId = await insertOutbox("DEAD", "clock_timestamp()");
  const dead = await runPostDeployApplicationSmoke(pool, baseInput);
  requireFailure(dead, "OUTBOX_DEAD_MESSAGES_PRESENT");
  await markSent(deadId);

  const recovered = await runPostDeployApplicationSmoke(pool, baseInput);
  if (!recovered.passed) {
    throw new Error(
      `Application smoke did not recover after proof fixtures cleared: ${recovered.failures.join(",")}`,
    );
  }

  console.log(
    JSON.stringify({
      proof: "phase17-application-smoke",
      applicationLayerPassed: true,
      missingSessionFailClosed: true,
      criticalDepthFailClosed: true,
      criticalAgeFailClosed: true,
      deadLetterFailClosed: true,
      providerLiveHealth: recovered.providerLiveHealth,
      finalPostDeploySmokeComplete: recovered.finalPostDeploySmokeComplete,
    }),
  );
} finally {
  await pool.end();
}
