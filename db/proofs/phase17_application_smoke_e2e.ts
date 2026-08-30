import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runPostDeployApplicationSmoke } from "../../src/operations/post-deploy-application-smoke.js";

const databaseUrl = process.env.DATABASE_URL;
const deploymentRevision = process.env.PROOF_REVISION;
const sourceWhatsappSessionKey = process.env.WHATSAPP_SESSION_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!deploymentRevision) throw new Error("PROOF_REVISION is required");
if (!sourceWhatsappSessionKey) throw new Error("WHATSAPP_SESSION_KEY is required");

const whatsappSessionKey = `${sourceWhatsappSessionKey.slice(0, 20)}-e2e-${randomUUID().slice(0, 8)}`;
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

function requireFailure(
  report: Awaited<ReturnType<typeof runPostDeployApplicationSmoke>>,
  code: string,
) {
  if (report.passed || !report.failures.includes(code)) {
    throw new Error(`Application smoke did not fail closed with ${code}`);
  }
}

function requireProviderFailure(
  report: Awaited<ReturnType<typeof runPostDeployApplicationSmoke>>,
  code: string,
) {
  requireFailure(report, code);
  if (
    String(report.providerLiveHealth) !== "UNHEALTHY" ||
    Boolean(report.finalPostDeploySmokeComplete)
  ) {
    throw new Error("Application smoke incorrectly claimed provider-live readiness");
  }
}

async function insertRuntimeEvidence(input: {
  deploymentRevision: string;
  whatsappSessionKey: string;
  providerState: "CONNECTED" | "DISCONNECTED";
  heartbeatSql: string;
}): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO runtime_instances(
       instance_id,
       environment,
       deployment_revision,
       whatsapp_session_key,
       provider_state,
       last_connected_at,
       last_heartbeat_at
     ) VALUES (
       $1,
       'staging',
       $2,
       $3,
       $4,
       CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE NULL END,
       ${input.heartbeatSql}
     )`,
    [instanceId, input.deploymentRevision, input.whatsappSessionKey, input.providerState],
  );
  return instanceId;
}

async function updateRuntimeEvidence(
  instanceId: string,
  providerState: "CONNECTED" | "DISCONNECTED",
  heartbeatSql: string,
): Promise<void> {
  await pool.query(
    `UPDATE runtime_instances
     SET started_at = least(started_at, ${heartbeatSql}),
         provider_state = $2,
         last_connected_at = CASE
           WHEN $2 = 'CONNECTED' THEN clock_timestamp()
           ELSE last_connected_at
         END,
         last_disconnect_at = CASE
           WHEN $2 = 'DISCONNECTED' THEN clock_timestamp()
           ELSE last_disconnect_at
         END,
         last_heartbeat_at = ${heartbeatSql}
     WHERE instance_id = $1`,
    [instanceId, providerState],
  );
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
  await pool.query(
    `INSERT INTO whatsapp_auth_sessions(
       session_key,
       credentials_ciphertext,
       credentials_iv,
       credentials_auth_tag,
       encryption_key_version
     ) VALUES (
       $1,
       decode('00', 'hex'),
       decode(repeat('00', 12), 'hex'),
       decode(repeat('00', 16), 'hex'),
       1
     )`,
    [whatsappSessionKey],
  );

  const baseInput = {
    environment: "staging" as const,
    deploymentRevision,
    whatsappSessionKey,
  };

  const missingEvidence = await runPostDeployApplicationSmoke(pool, baseInput);
  requireProviderFailure(missingEvidence, "PROVIDER_RUNTIME_EVIDENCE_MISSING");

  await insertRuntimeEvidence({
    deploymentRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    whatsappSessionKey,
    providerState: "CONNECTED",
    heartbeatSql: "clock_timestamp()",
  });
  const wrongRevision = await runPostDeployApplicationSmoke(pool, baseInput);
  requireProviderFailure(wrongRevision, "PROVIDER_RUNTIME_EVIDENCE_MISSING");

  await insertRuntimeEvidence({
    deploymentRevision,
    whatsappSessionKey: "different-proof-session",
    providerState: "CONNECTED",
    heartbeatSql: "clock_timestamp()",
  });
  const wrongSession = await runPostDeployApplicationSmoke(pool, baseInput);
  requireProviderFailure(wrongSession, "PROVIDER_RUNTIME_EVIDENCE_MISSING");

  const exactInstanceId = await insertRuntimeEvidence({
    deploymentRevision,
    whatsappSessionKey,
    providerState: "DISCONNECTED",
    heartbeatSql: "clock_timestamp()",
  });
  const disconnected = await runPostDeployApplicationSmoke(pool, baseInput);
  requireProviderFailure(disconnected, "PROVIDER_NOT_CONNECTED");

  await updateRuntimeEvidence(
    exactInstanceId,
    "CONNECTED",
    "clock_timestamp() - interval '10 minutes'",
  );
  const stale = await runPostDeployApplicationSmoke(pool, baseInput);
  requireProviderFailure(stale, "PROVIDER_HEARTBEAT_STALE");

  await updateRuntimeEvidence(exactInstanceId, "CONNECTED", "clock_timestamp()");
  const happy = await runPostDeployApplicationSmoke(pool, baseInput);
  if (!happy.passed) {
    throw new Error(`Prepared application smoke unexpectedly failed: ${happy.failures.join(",")}`);
  }
  if (
    String(happy.providerLiveHealth) !== "HEALTHY" ||
    !Boolean(happy.finalPostDeploySmokeComplete)
  ) {
    throw new Error("Application smoke did not prove final provider-live readiness");
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

  const ageId = await insertOutbox("PENDING", "clock_timestamp() - interval '10 minutes'");
  const age = await runPostDeployApplicationSmoke(pool, baseInput);
  requireFailure(age, "OUTBOX_CRITICAL_AGE");
  await markSent(ageId);

  const deadId = await insertOutbox("DEAD", "clock_timestamp()");
  const dead = await runPostDeployApplicationSmoke(pool, baseInput);
  requireFailure(dead, "OUTBOX_DEAD_MESSAGES_PRESENT");
  await markSent(deadId);

  const recovered = await runPostDeployApplicationSmoke(pool, baseInput);
  if (
    !recovered.passed ||
    String(recovered.providerLiveHealth) !== "HEALTHY" ||
    !Boolean(recovered.finalPostDeploySmokeComplete)
  ) {
    throw new Error(
      `Application smoke did not recover after proof fixtures cleared: ${recovered.failures.join(",")}`,
    );
  }

  console.log(
    JSON.stringify({
      proof: "phase17-application-smoke",
      applicationLayerPassed: true,
      isolatedSessionEvidence: true,
      missingProviderEvidenceFailClosed: true,
      wrongRevisionFailClosed: true,
      wrongSessionFailClosed: true,
      disconnectedProviderFailClosed: true,
      staleHeartbeatFailClosed: true,
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
