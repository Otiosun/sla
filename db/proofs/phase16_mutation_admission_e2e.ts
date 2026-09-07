import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  MutationRatePolicy,
  MutationSurface,
} from "../../src/modules/anti-abuse/contracts.js";
import { mutationFingerprint } from "../../src/modules/anti-abuse/fingerprint.js";
import { PostgresMutationAdmission } from "../../src/platform/anti-abuse/postgres-mutation-admission.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const subjectId = randomUUID();
const policy = (key: string, maxEvents: number): MutationRatePolicy => ({
  policyKey: key,
  maxEvents,
  windowMs: 60_000,
});

try {
  await pool.query("TRUNCATE mutation_rate_limit_charges, mutation_rate_limit_buckets");
  const admission = new PostgresMutationAdmission(pool);

  for (const surface of [
    "CAPTURE",
    "BATTLE",
    "ECONOMY",
    "ADMIN",
  ] as const satisfies readonly MutationSurface[]) {
    const surfacePolicy = policy(`proof.${surface.toLowerCase()}.v1`, 1);
    const base = {
      subjectKind: surface === "ADMIN" ? ("ADMIN_PRINCIPAL" as const) : ("PLAYER" as const),
      subjectId,
      surface,
      actionKey: `proof.${surface.toLowerCase()}`,
      dedupeKey: `${surface}:first`,
      requestFingerprint: mutationFingerprint({ surface, semantic: "first" }),
      policy: surfacePolicy,
    };

    const first = await admission.consume(base);
    if (!first.ok || !first.value.allowed || first.value.replayed) {
      throw new Error(`${surface} first admission failed`);
    }

    const replay = await admission.consume(base);
    if (!replay.ok || !replay.value.allowed || !replay.value.replayed) {
      throw new Error(`${surface} exact replay was charged again`);
    }

    const drift = await admission.consume({
      ...base,
      requestFingerprint: mutationFingerprint({ surface, semantic: "changed" }),
    });
    if (drift.ok || drift.error.code !== "FINGERPRINT_MISMATCH") {
      throw new Error(`${surface} semantic drift did not fail closed`);
    }

    const blocked = await admission.consume({
      ...base,
      dedupeKey: `${surface}:second`,
      requestFingerprint: mutationFingerprint({ surface, semantic: "second" }),
    });
    if (!blocked.ok || blocked.value.allowed) {
      throw new Error(`${surface} budget did not block a new mutation`);
    }
  }

  const surfaceEvidence = await pool.query<{ surface: string; count: string }>(
    `SELECT surface, count(*)::text AS count
     FROM mutation_rate_limit_charges
     WHERE policy_key LIKE 'proof.%'
     GROUP BY surface`,
  );
  if (surfaceEvidence.rows.length !== 4 || surfaceEvidence.rows.some((row) => row.count !== "1")) {
    throw new Error("Blocked/replayed mutations created unexpected durable charges");
  }

  const raceSubject = randomUUID();
  const racePolicy = policy("proof.concurrent.v1", 3);
  const raced = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      admission.consume({
        subjectKind: "PLAYER",
        subjectId: raceSubject,
        surface: "BATTLE",
        actionKey: "proof.concurrent",
        dedupeKey: `race:${index}`,
        requestFingerprint: mutationFingerprint({ index }),
        policy: racePolicy,
      }),
    ),
  );
  const allowed = raced.filter((result) => result.ok && result.value.allowed).length;
  const blocked = raced.filter((result) => result.ok && !result.value.allowed).length;
  if (allowed !== 3 || blocked !== 21) {
    throw new Error(`Concurrent budget mismatch: allowed=${allowed}, blocked=${blocked}`);
  }

  const durable = await pool.query<{ used: number; charges: string }>(
    `SELECT b.used,
            (SELECT count(*)::text FROM mutation_rate_limit_charges c
             WHERE c.subject_kind=b.subject_kind AND c.subject_hash=b.subject_hash
               AND c.surface=b.surface AND c.policy_key=b.policy_key) AS charges
     FROM mutation_rate_limit_buckets b
     WHERE b.policy_key=$1`,
    [racePolicy.policyKey],
  );
  if (durable.rows[0]?.used !== 3 || durable.rows[0]?.charges !== "3") {
    throw new Error("Concurrent admission overshot its durable budget");
  }

  const duplicateSubject = randomUUID();
  const duplicatePolicy = policy("proof.concurrent-replay.v1", 5);
  const duplicateRequest = {
    subjectKind: "PLAYER" as const,
    subjectId: duplicateSubject,
    surface: "CAPTURE" as const,
    actionKey: "proof.concurrent-replay",
    dedupeKey: "duplicate:shared",
    requestFingerprint: mutationFingerprint({ semantic: "same-concurrent-request" }),
    policy: duplicatePolicy,
  };
  const duplicateRaced = await Promise.all(
    Array.from({ length: 24 }, () => admission.consume(duplicateRequest)),
  );
  const duplicateFresh = duplicateRaced.filter(
    (result) => result.ok && result.value.allowed && !result.value.replayed,
  ).length;
  const duplicateReplays = duplicateRaced.filter(
    (result) => result.ok && result.value.allowed && result.value.replayed,
  ).length;
  if (duplicateFresh !== 1 || duplicateReplays !== 23) {
    throw new Error(
      `Concurrent duplicate replay mismatch: fresh=${duplicateFresh}, replayed=${duplicateReplays}`,
    );
  }
  const duplicateDurable = await pool.query<{ used: number; charges: string }>(
    `SELECT b.used,
            (SELECT count(*)::text FROM mutation_rate_limit_charges c
             WHERE c.subject_kind=b.subject_kind AND c.subject_hash=b.subject_hash
               AND c.surface=b.surface AND c.policy_key=b.policy_key) AS charges
     FROM mutation_rate_limit_buckets b
     WHERE b.policy_key=$1`,
    [duplicatePolicy.policyKey],
  );
  if (duplicateDurable.rows[0]?.used !== 1 || duplicateDurable.rows[0]?.charges !== "1") {
    throw new Error("Concurrent duplicate request created more than one durable charge");
  }

  const principalPolicy = policy("proof.scope.principal.v1", 1);
  const principalDedupeKey = "scope:principal:shared";
  const principalFingerprint = mutationFingerprint({ semantic: "same-principal-scope-request" });
  const principalResults = await Promise.all(
    [randomUUID(), randomUUID()].map((principalSubjectId) =>
      admission.consume({
        subjectKind: "ADMIN_PRINCIPAL",
        subjectId: principalSubjectId,
        surface: "ADMIN",
        actionKey: "proof.scope.principal",
        dedupeKey: principalDedupeKey,
        requestFingerprint: principalFingerprint,
        policy: principalPolicy,
      }),
    ),
  );
  if (
    principalResults.some(
      (result) => !result.ok || !result.value.allowed || result.value.replayed,
    )
  ) {
    throw new Error("Independent admin principals shared one mutation admission bucket or charge");
  }
  const principalEvidence = await pool.query<{ buckets: string; charges: string }>(
    `SELECT
       (SELECT count(*)::text FROM mutation_rate_limit_buckets WHERE policy_key=$1) AS buckets,
       (SELECT count(*)::text FROM mutation_rate_limit_charges WHERE policy_key=$1) AS charges`,
    [principalPolicy.policyKey],
  );
  if (principalEvidence.rows[0]?.buckets !== "2" || principalEvidence.rows[0]?.charges !== "2") {
    throw new Error("Principal-scoped admission was not durably isolated");
  }

  const policySubject = randomUUID();
  const policySharedDedupe = "scope:policy:shared";
  const policySharedFingerprint = mutationFingerprint({ semantic: "same-policy-scope-request" });
  const policyResults = await Promise.all(
    [policy("proof.scope.policy-a.v1", 1), policy("proof.scope.policy-b.v1", 1)].map(
      (scopedPolicy) =>
        admission.consume({
          subjectKind: "PLAYER",
          subjectId: policySubject,
          surface: "BATTLE",
          actionKey: "proof.scope.policy",
          dedupeKey: policySharedDedupe,
          requestFingerprint: policySharedFingerprint,
          policy: scopedPolicy,
        }),
    ),
  );
  if (
    policyResults.some((result) => !result.ok || !result.value.allowed || result.value.replayed)
  ) {
    throw new Error("Independent mutation policies shared one admission bucket or charge");
  }

  const surfaceSubject = randomUUID();
  const sharedSurfacePolicy = policy("proof.scope.surface.v1", 1);
  const surfaceSharedDedupe = "scope:surface:shared";
  const surfaceResults = await Promise.all(
    (["BATTLE", "ECONOMY"] as const).map((surface) =>
      admission.consume({
        subjectKind: "PLAYER",
        subjectId: surfaceSubject,
        surface,
        actionKey: "proof.scope.surface",
        dedupeKey: surfaceSharedDedupe,
        requestFingerprint: mutationFingerprint({ surface, semantic: "same-surface-scope-request" }),
        policy: sharedSurfacePolicy,
      }),
    ),
  );
  if (
    surfaceResults.some((result) => !result.ok || !result.value.allowed || result.value.replayed)
  ) {
    throw new Error("Independent mutation surfaces shared one admission bucket or charge");
  }
  const surfaceScopeEvidence = await pool.query<{ buckets: string; charges: string }>(
    `SELECT
       (SELECT count(*)::text FROM mutation_rate_limit_buckets WHERE policy_key=$1) AS buckets,
       (SELECT count(*)::text FROM mutation_rate_limit_charges WHERE policy_key=$1) AS charges`,
    [sharedSurfacePolicy.policyKey],
  );
  if (
    surfaceScopeEvidence.rows[0]?.buckets !== "2" ||
    surfaceScopeEvidence.rows[0]?.charges !== "2"
  ) {
    throw new Error("Surface-scoped admission was not durably isolated");
  }

  const restarted = new PostgresMutationAdmission(pool);
  const afterRestart = await restarted.consume({
    subjectKind: "PLAYER",
    subjectId: raceSubject,
    surface: "BATTLE",
    actionKey: "proof.concurrent",
    dedupeKey: "race:after-restart",
    requestFingerprint: mutationFingerprint({ afterRestart: true }),
    policy: racePolicy,
  });
  if (!afterRestart.ok || afterRestart.value.allowed) {
    throw new Error("Restarted admission forgot exhausted durable budget");
  }

  const replayAfterRestart = await restarted.consume({
    subjectKind: "PLAYER",
    subjectId: raceSubject,
    surface: "BATTLE",
    actionKey: "proof.concurrent",
    dedupeKey: "race:0",
    requestFingerprint: mutationFingerprint({ index: 0 }),
    policy: racePolicy,
  });
  if (
    !replayAfterRestart.ok ||
    !replayAfterRestart.value.allowed ||
    !replayAfterRestart.value.replayed
  ) {
    throw new Error("Exact replay after restart lost its original admission");
  }

  const privacy = await pool.query<{ bad_subject: string; bad_dedupe: string; raw_hits: string }>(
    `SELECT
       count(*) FILTER (WHERE subject_hash !~ '^[0-9a-f]{64}$')::text AS bad_subject,
       count(*) FILTER (WHERE dedupe_hash !~ '^[0-9a-f]{64}$')::text AS bad_dedupe,
       count(*) FILTER (WHERE subject_hash IN ($1,$2))::text AS raw_hits
     FROM mutation_rate_limit_charges`,
    [subjectId, raceSubject],
  );
  const row = privacy.rows[0];
  if (row?.bad_subject !== "0" || row.bad_dedupe !== "0" || row.raw_hits !== "0") {
    throw new Error("Admission persisted raw or malformed identifiers");
  }

  console.log(
    JSON.stringify({
      proof: "phase16-mutation-admission",
      surfaces: 4,
      concurrentAllowed: allowed,
      concurrentBlocked: blocked,
      concurrentDuplicateFresh: duplicateFresh,
      concurrentDuplicateReplays: duplicateReplays,
      principalScopeIsolated: true,
      policyScopeIsolated: true,
      surfaceScopeIsolated: true,
      restartPreserved: true,
      replayNoDoubleCharge: true,
      rawIdentifiersPersisted: false,
    }),
  );
} finally {
  await pool.end();
}
