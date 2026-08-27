import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CEncounterAdminOperations } from "../../src/modules/admin/encounter-definitions.js";
import { AdminEncounterOperationService } from "../../src/modules/admin/encounter-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { EncounterAdminOwnerService } from "../../src/modules/encounter/admin-service.js";
import { parseEncounterId, parsePlayerId } from "../../src/shared-kernel/ids.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresEncounterAdminRepository } from "../../src/platform/encounter/postgres-encounter-admin-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

function expectAdminCode(error: unknown, code: string): void {
  if (!(error instanceof AdminError) || error.code !== code) {
    throw error instanceof Error ? error : new Error(`Expected ${code}`);
  }
}

async function expectRejected(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Expected rejection ${code}`);
    },
    (error: unknown) => expectAdminCode(error, code),
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const ballItemId = randomUUID();
  const globalPrincipalId = randomUUID();
  const supportPrincipalId = randomUUID();

  const validPlayerId = randomUUID();
  const deniedPlayerId = randomUUID();
  const stalePlayerId = randomUUID();
  const capturePlayerId = randomUUID();
  const activeBattlePlayerId = randomUUID();
  const unsettledPlayerId = randomUUID();

  const validEncounterId = randomUUID();
  const deniedEncounterId = randomUUID();
  const staleEncounterId = randomUUID();
  const captureEncounterId = randomUUID();
  const activeBattleEncounterId = randomUUID();
  const unsettledEncounterId = randomUUID();

  const activeBattleId = randomUUID();
  const unsettledBattleId = randomUUID();

  const nextRelease = await pool.query<{ release_no: string }>(
    `SELECT (COALESCE(MAX(release_no), 950000) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = nextRelease.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate Encounter admin proof release");

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `phase12-encounter-admin-${rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 12 Encounter Admin Proof', 'DRAFT', $3)`,
    [releaseId, releaseNo, rulesetId],
  );
  await pool.query(`INSERT INTO regions(id, slug) VALUES ($1, $2)`, [
    regionId,
    `phase12-encounter-admin-region-${regionId}`,
  ]);
  await pool.query(`INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)`, [
    areaId,
    regionId,
    `phase12-encounter-admin-area-${areaId}`,
  ]);
  await pool.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [
    ballItemId,
    `phase12-encounter-admin-ball-${ballItemId}`,
  ]);

  const playerIds = [
    validPlayerId,
    deniedPlayerId,
    stalePlayerId,
    capturePlayerId,
    activeBattlePlayerId,
    unsettledPlayerId,
  ];
  for (const playerId of playerIds) {
    await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [playerId]);
  }

  const seedCiphertext = Buffer.alloc(32, 1);
  const seedIv = Buffer.alloc(12, 2);
  const seedAuthTag = Buffer.alloc(16, 3);

  async function insertEncounter(
    encounterId: string,
    playerId: string,
    status: "PRESENTED" | "ENGAGED" | "CAPTURE_RESOLVING" | "IN_BATTLE",
  ): Promise<void> {
    await pool.query(
      `INSERT INTO encounters(
         id, player_id, area_id, status, content_release_id, ruleset_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
         rng_counter, revision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 0, 0)`,
      [
        encounterId,
        playerId,
        areaId,
        status,
        releaseId,
        rulesetId,
        seedCiphertext,
        seedIv,
        seedAuthTag,
      ],
    );
  }

  await insertEncounter(validEncounterId, validPlayerId, "PRESENTED");
  await insertEncounter(deniedEncounterId, deniedPlayerId, "ENGAGED");
  await insertEncounter(staleEncounterId, stalePlayerId, "ENGAGED");
  await insertEncounter(captureEncounterId, capturePlayerId, "ENGAGED");
  await insertEncounter(activeBattleEncounterId, activeBattlePlayerId, "IN_BATTLE");
  await insertEncounter(unsettledEncounterId, unsettledPlayerId, "IN_BATTLE");

  async function insertBattle(
    battleId: string,
    encounterId: string,
    status: "ACTIVE" | "WON",
  ): Promise<void> {
    await pool.query(
      `INSERT INTO battles(
         id, battle_type, status, content_release_id, ruleset_id, encounter_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version, rng_counter,
         ended_at
       ) VALUES ($1, 'WILD', $2, $3, $4, $5, $6, $7, $8, 1, 0, $9)`,
      [
        battleId,
        status,
        releaseId,
        rulesetId,
        encounterId,
        seedCiphertext,
        seedIv,
        seedAuthTag,
        status === "WON" ? new Date() : null,
      ],
    );
  }

  await insertBattle(activeBattleId, activeBattleEncounterId, "ACTIVE");
  await insertBattle(unsettledBattleId, unsettledEncounterId, "WON");

  await pool.query(
    `INSERT INTO capture_attempts(
       id, player_id, encounter_id, ball_item_id, idempotency_key,
       status, probability_basis_points, roll_basis_points,
       request_fingerprint, source_encounter_status, correlation_id,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version, rng_counter,
       breakdown
     ) VALUES (
       $1, $2, $3, $4, $5,
       'PENDING', 5000, 4999,
       $6, 'ENGAGED', $7,
       $8, $9, $10, 1, 1,
       '{}'::jsonb
     )`,
    [
      randomUUID(),
      capturePlayerId,
      captureEncounterId,
      ballItemId,
      `phase12-encounter-capture-${randomUUID()}`,
      "c".repeat(64),
      randomUUID(),
      seedCiphertext,
      seedIv,
      seedAuthTag,
    ],
  );

  const seniorRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SENIOR_ADMIN'`,
  );
  const supportRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SUPPORT'`,
  );
  const seniorRoleId = seniorRole.rows[0]?.id;
  const supportRoleId = supportRole.rows[0]?.id;
  if (seniorRoleId === undefined || supportRoleId === undefined) {
    throw new Error("Phase 12 Encounter admin proof requires seeded admin roles");
  }

  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE')`,
    [
      globalPrincipalId,
      `phase12:encounter-admin:${globalPrincipalId}`,
      supportPrincipalId,
      `phase12:encounter-support:${supportPrincipalId}`,
    ],
  );
  await pool.query(
    `INSERT INTO admin_principal_roles(principal_id, role_id)
     VALUES ($1, $2), ($3, $4)`,
    [globalPrincipalId, seniorRoleId, supportPrincipalId, supportRoleId],
  );
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'GLOBAL', NULL), ($3, $4, 'PLAYER', $5)`,
    [randomUUID(), globalPrincipalId, randomUUID(), supportPrincipalId, validPlayerId],
  );

  const adminRepository = new PostgresAdminRepository(pool);
  const registry = createPhase12AdminOperationRegistry(adminRepository);
  const admin = new AdminService(registry, adminRepository);
  const owner = new EncounterAdminOwnerService(new PostgresEncounterAdminRepository(pool));
  const encounterAdmin = new AdminEncounterOperationService(
    admin,
    owner,
    new PostgresAdminOperationCompletion(pool),
  );
  registerPhase12CEncounterAdminOperations(registry, encounterAdmin);

  const inspected = await encounterAdmin.inspect({
    principalId: supportPrincipalId,
    playerId: validPlayerId,
    encounterId: validEncounterId,
  });
  if (inspected.status !== "PRESENTED" || inspected.revision !== "0") {
    throw new Error("Scoped Encounter inspect did not return the expected state");
  }
  await expectRejected(
    encounterAdmin.inspect({
      principalId: supportPrincipalId,
      playerId: deniedPlayerId,
      encounterId: deniedEncounterId,
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  const closeCorrelationId = randomUUID();
  const closePrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "encounter.close",
    input: { playerId: validPlayerId, encounterId: validEncounterId },
    reason: "Recover a stuck Encounter that never reached its terminal close",
    expectedRevision: 0n,
    idempotencyKey: `encounter-close-${randomUUID()}`,
    correlationId: closeCorrelationId,
  });
  if (closePrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Encounter close must require explicit R3 confirmation");
  }
  await expectRejected(
    admin.apply(closePrepared.operation.id, globalPrincipalId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  await admin.confirm(closePrepared.operation.id, globalPrincipalId);

  const parsedValidPlayer = parsePlayerId(validPlayerId);
  const parsedValidEncounter = parseEncounterId(validEncounterId);
  if (!parsedValidPlayer.ok || !parsedValidEncounter.ok) {
    throw new Error("Generated Encounter admin proof ids failed canonical parsers");
  }

  const ownerFirst = await owner.close({
    playerId: parsedValidPlayer.value,
    encounterId: parsedValidEncounter.value,
    expectedRevision: 0n,
    idempotencyKey: closePrepared.operation.id,
    correlationId: closeCorrelationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: closePrepared.operation.id,
      reason: closePrepared.operation.reason ?? "",
      actorType: "ADMIN",
      actorId: globalPrincipalId,
    },
  });
  if (!ownerFirst.ok || ownerFirst.value.replayed || ownerFirst.value.afterRevision !== "1") {
    throw new Error("Encounter owner crash-window setup did not close exactly once");
  }

  const recovered = await admin.apply(closePrepared.operation.id, globalPrincipalId);
  if (
    recovered.status !== "APPLIED" ||
    recovered.result?.ownerReplayed !== true ||
    recovered.result?.afterRevision !== "1"
  ) {
    throw new Error("Encounter admin crash recovery did not replay durable owner evidence");
  }

  const recoveredEvidence = await pool.query<{
    status: string;
    revision: string;
    claim_count: string;
    change_count: string;
    audit_count: string;
  }>(
    `SELECT encounter.status,
            encounter.revision::text,
            (SELECT count(*)::text FROM encounter_admin_operation_claims
             WHERE idempotency_key = $2) AS claim_count,
            (SELECT count(*)::text FROM admin_operation_changes
             WHERE admin_operation_id = $2) AS change_count,
            (SELECT count(*)::text FROM audit_events
             WHERE causation_id = $2) AS audit_count
     FROM encounters encounter
     WHERE encounter.id = $1`,
    [validEncounterId, closePrepared.operation.id],
  );
  const recoveredRow = recoveredEvidence.rows[0];
  if (
    recoveredRow?.status !== "CLOSED" ||
    recoveredRow.revision !== "1" ||
    recoveredRow.claim_count !== "1" ||
    recoveredRow.change_count !== "1" ||
    recoveredRow.audit_count !== "1"
  ) {
    throw new Error("Encounter close recovery left incomplete or duplicated evidence");
  }

  const replayConflict = await owner.close({
    playerId: parsedValidPlayer.value,
    encounterId: parsedValidEncounter.value,
    expectedRevision: 1n,
    idempotencyKey: closePrepared.operation.id,
    correlationId: closeCorrelationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: closePrepared.operation.id,
      reason: closePrepared.operation.reason ?? "",
      actorType: "ADMIN",
      actorId: globalPrincipalId,
    },
  });
  if (replayConflict.ok || replayConflict.error.code !== "FINGERPRINT_MISMATCH") {
    throw new Error("Encounter owner accepted semantic idempotency drift");
  }

  await pool
    .query(
      `UPDATE encounter_admin_operation_claims
       SET result = '{}'::jsonb
       WHERE idempotency_key = $1`,
      [closePrepared.operation.id],
    )
    .then(
      () => {
        throw new Error("Encounter admin claims must be append-only");
      },
      () => undefined,
    );

  const stalePrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "encounter.close",
    input: { playerId: stalePlayerId, encounterId: staleEncounterId },
    reason: "Stale Encounter close CAS proof",
    expectedRevision: 0n,
    idempotencyKey: `encounter-stale-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(stalePrepared.operation.id, globalPrincipalId);
  await pool.query(
    `UPDATE encounters SET revision = revision + 1, updated_at = now() WHERE id = $1`,
    [staleEncounterId],
  );
  await expectRejected(
    admin.apply(stalePrepared.operation.id, globalPrincipalId),
    ADMIN_ERROR_CODES.REVISION_CONFLICT,
  );

  const capturePrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "encounter.close",
    input: { playerId: capturePlayerId, encounterId: captureEncounterId },
    reason: "Pending capture close rejection proof",
    expectedRevision: 0n,
    idempotencyKey: `encounter-capture-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(capturePrepared.operation.id, globalPrincipalId);
  await expectRejected(
    admin.apply(capturePrepared.operation.id, globalPrincipalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  const activeBattlePrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "encounter.close",
    input: { playerId: activeBattlePlayerId, encounterId: activeBattleEncounterId },
    reason: "Active Battle close rejection proof",
    expectedRevision: 0n,
    idempotencyKey: `encounter-active-battle-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(activeBattlePrepared.operation.id, globalPrincipalId);
  await expectRejected(
    admin.apply(activeBattlePrepared.operation.id, globalPrincipalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  const unsettledPrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "encounter.close",
    input: { playerId: unsettledPlayerId, encounterId: unsettledEncounterId },
    reason: "PvE reward settlement close gate proof",
    expectedRevision: 0n,
    idempotencyKey: `encounter-unsettled-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(unsettledPrepared.operation.id, globalPrincipalId);
  await expectRejected(
    admin.apply(unsettledPrepared.operation.id, globalPrincipalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  await pool.query(
    `INSERT INTO battle_reward_claims(
       battle_id, player_id, idempotency_key, request_fingerprint, result, correlation_id
     ) VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [unsettledBattleId, unsettledPlayerId, "a".repeat(64), "b".repeat(64), randomUUID()],
  );
  const settledApplied = await admin.apply(unsettledPrepared.operation.id, globalPrincipalId);
  if (
    settledApplied.status !== "APPLIED" ||
    settledApplied.result?.ownerReplayed !== false ||
    settledApplied.result?.afterRevision !== "1"
  ) {
    throw new Error("Settled terminal PvE Encounter did not become safely closable");
  }

  const blockedState = await pool.query<{
    capture_status: string;
    active_battle_status: string;
    capture_claims: string;
    battle_claims: string;
  }>(
    `SELECT
       (SELECT status FROM encounters WHERE id = $1) AS capture_status,
       (SELECT status FROM encounters WHERE id = $2) AS active_battle_status,
       (SELECT count(*)::text FROM encounter_admin_operation_claims
        WHERE idempotency_key = $3) AS capture_claims,
       (SELECT count(*)::text FROM encounter_admin_operation_claims
        WHERE idempotency_key = $4) AS battle_claims`,
    [
      captureEncounterId,
      activeBattleEncounterId,
      capturePrepared.operation.id,
      activeBattlePrepared.operation.id,
    ],
  );
  const blockedRow = blockedState.rows[0];
  if (
    blockedRow?.capture_status !== "ENGAGED" ||
    blockedRow.active_battle_status !== "IN_BATTLE" ||
    blockedRow.capture_claims !== "0" ||
    blockedRow.battle_claims !== "0"
  ) {
    throw new Error("Rejected Encounter close leaked partial state or replay evidence");
  }

  console.log(
    "Phase 12 Encounter admin proof complete: scoped inspect, R3 confirmation, CAS, crash replay, append-only claims, capture/Battle guards and reward-settlement recovery verified",
  );
} finally {
  await pool.end();
}
