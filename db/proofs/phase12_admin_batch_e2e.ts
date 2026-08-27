import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12DBatchAdminOperations } from "../../src/modules/admin/batch-definitions.js";
import { AdminBatchService } from "../../src/modules/admin/batch-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import { PostgresAdminBatchRepository } from "../../src/platform/admin/postgres-admin-batch-repository.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

function expectAdminCode(error: unknown, code: string): void {
  if (!(error instanceof AdminError) || error.code !== code) {
    throw error instanceof Error ? error : new Error(`Expected admin error ${code}`);
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

async function expectSqlState(
  promise: Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`${label} unexpectedly succeeded`);
    },
    (error: unknown) => {
      const actual =
        error !== null && typeof error === "object" && "code" in error
          ? String((error as { readonly code?: unknown }).code ?? "")
          : "";
      if (actual !== code) throw error;
    },
  );
}

function resultString(result: Readonly<Record<string, unknown>> | null, key: string): string {
  const value = result?.[key];
  if (typeof value !== "string") throw new Error(`Expected result.${key} string`);
  return value;
}

function resultNumber(result: Readonly<Record<string, unknown>> | null, key: string): number {
  const value = result?.[key];
  if (typeof value !== "number") throw new Error(`Expected result.${key} number`);
  return value;
}

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
try {
  const economyRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'ECONOMY_ADMIN'`,
  );
  const economyRoleId = economyRole.rows[0]?.id;
  if (economyRoleId === undefined) throw new Error("ECONOMY_ADMIN role must be seeded");

  const regionId = randomUUID();
  const currencyId = randomUUID();
  const itemId = randomUUID();
  const playerA = randomUUID();
  const playerB = randomUUID();
  const latePlayer = randomUUID();
  const principalId = randomUUID();
  const scopedPrincipalId = randomUUID();
  const batchOnlyPrincipalId = randomUUID();
  const batchOnlyRoleId = randomUUID();

  await pool.query(`INSERT INTO regions(id, slug) VALUES ($1, $2)`, [
    regionId,
    `phase12-batch-region-${regionId}`,
  ]);
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'Batch Coins', FALSE)`,
    [currencyId, `phase12-batch-currency-${currencyId}`],
  );
  await pool.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [
    itemId,
    `phase12-batch-item-${itemId}`,
  ]);
  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`, [
    playerA,
    playerB,
  ]);
  await pool.query(
    `INSERT INTO player_profiles(player_id, trainer_name, origin_region_id)
     VALUES ($1, 'Batch A', $3), ($2, 'Batch B', $3)`,
    [playerA, playerB, regionId],
  );
  await pool.query(
    `INSERT INTO wallet_balances(player_id, currency_id, amount)
     VALUES ($1, $3, 100), ($2, $3, 100)`,
    [playerA, playerB, currencyId],
  );
  await pool.query(
    `INSERT INTO trainer_progression(player_id, level, progression_points)
     VALUES ($1, 1, 0), ($2, 1, 0)`,
    [playerA, playerB],
  );

  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE'), ($5, $6, 'ACTIVE')`,
    [
      principalId,
      `phase12:batch-global:${principalId}`,
      scopedPrincipalId,
      `phase12:batch-scoped:${scopedPrincipalId}`,
      batchOnlyPrincipalId,
      `phase12:batch-only:${batchOnlyPrincipalId}`,
    ],
  );
  await pool.query(
    `INSERT INTO admin_principal_roles(principal_id, role_id)
     VALUES ($1, $3), ($2, $3)`,
    [principalId, scopedPrincipalId, economyRoleId],
  );
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'GLOBAL', NULL), ($3, $4, 'PLAYER', $5)`,
    [randomUUID(), principalId, randomUUID(), scopedPrincipalId, playerA],
  );

  await pool.query(`INSERT INTO admin_roles(id, slug, name) VALUES ($1, $2, 'Batch Only Proof')`, [
    batchOnlyRoleId,
    `BATCH_ONLY_${batchOnlyRoleId.replaceAll("-", "")}`,
  ]);
  await pool.query(
    `INSERT INTO admin_role_capabilities(role_id, capability_id)
     SELECT $1, id FROM capabilities
     WHERE key = ANY($2::text[])`,
    [batchOnlyRoleId, ["batch.preview", "batch.execute.low_risk"]],
  );
  await pool.query(`INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`, [
    batchOnlyPrincipalId,
    batchOnlyRoleId,
  ]);
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'GLOBAL', NULL)`,
    [randomUUID(), batchOnlyPrincipalId],
  );

  const adminRepository = new PostgresAdminRepository(pool);
  const completion = new PostgresAdminOperationCompletion(pool);
  const economy = new EconomyService(new PostgresEconomyRepository(pool));
  const progression = new ProgressionService(new PostgresProgressionRepository(pool));
  const domain = new AdminDomainOperationService(economy, progression, completion);
  const registry = registerPhase12CDomainAdminOperations(
    createPhase12AdminOperationRegistry(adminRepository),
    domain,
  );
  const admin = new AdminService(registry, adminRepository);
  const batchRepository = new PostgresAdminBatchRepository(pool);
  const batch = new AdminBatchService(
    admin,
    registry,
    adminRepository,
    batchRepository,
    completion,
  );
  registerPhase12DBatchAdminOperations(registry, batch);

  await expectRejected(
    admin.prepareMutation({
      principalId: scopedPrincipalId,
      operationType: "batch.preview",
      input: {
        selector: { kind: "PLAYER_IDS", playerIds: [playerA] },
        action: { kind: "WALLET_ADJUST", currencyId, delta: "1" },
        chunkSize: 1,
      },
      reason: "Scoped principal must not batch",
      idempotencyKey: `batch-scoped-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  const noChildCapability = await admin.prepareMutation({
    principalId: batchOnlyPrincipalId,
    operationType: "batch.preview",
    input: {
      selector: { kind: "PLAYER_IDS", playerIds: [playerA] },
      action: { kind: "WALLET_ADJUST", currencyId, delta: "1" },
      chunkSize: 1,
    },
    reason: "Batch child capability denial proof",
    idempotencyKey: `batch-child-cap-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await expectRejected(
    admin.apply(noChildCapability.operation.id, batchOnlyPrincipalId),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );
  await expectRejected(
    admin.prepareMutation({
      principalId,
      operationType: "batch.execute.high_risk",
      input: { batchId: randomUUID() },
      reason: "High-risk batch must remain closed",
      expectedRevision: 0n,
      idempotencyKey: `batch-high-risk-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.OPERATION_NOT_REGISTERED,
  );

  const previewPrepared = await admin.prepareMutation({
    principalId,
    operationType: "batch.preview",
    input: {
      selector: { kind: "PLAYER_FILTER", originRegionId: regionId, limit: 10 },
      action: { kind: "WALLET_ADJUST", currencyId, delta: "10" },
      chunkSize: 1,
    },
    reason: "Phase 12.24 frozen target wallet batch",
    idempotencyKey: `batch-preview-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (previewPrepared.operation.status !== "READY")
    throw new Error("Batch preview is not R2 READY");
  const previewApplied = await admin.apply(previewPrepared.operation.id, principalId);
  if (previewApplied.status !== "APPLIED") throw new Error("Batch preview did not apply");
  const batchId = resultString(previewApplied.result, "batchId");
  if (resultNumber(previewApplied.result, "targetCount") !== 2) {
    throw new Error("Batch preview did not freeze exactly two targets");
  }

  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [latePlayer]);
  await pool.query(
    `INSERT INTO player_profiles(player_id, trainer_name, origin_region_id)
     VALUES ($1, 'Batch Late', $2)`,
    [latePlayer, regionId],
  );
  await pool.query(
    `INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 100)`,
    [latePlayer, currencyId],
  );

  const frozenTargets = await pool.query<{ player_id: string }>(
    `SELECT player_id FROM admin_batch_targets WHERE batch_id = $1 ORDER BY ordinal`,
    [batchId],
  );
  if (
    frozenTargets.rows.length !== 2 ||
    frozenTargets.rows.some((row) => row.player_id === latePlayer)
  ) {
    throw new Error("Batch target snapshot drifted after preview");
  }
  await expectSqlState(
    pool.query(
      `UPDATE admin_batch_targets SET child_input = '{}'::jsonb WHERE batch_id = $1 AND ordinal = 0`,
      [batchId],
    ),
    "55000",
    "Admin batch target UPDATE",
  );
  await expectSqlState(
    pool.query(`DELETE FROM admin_batch_targets WHERE batch_id = $1 AND ordinal = 0`, [batchId]),
    "55000",
    "Admin batch target DELETE",
  );

  const staleExecute = await admin.prepareMutation({
    principalId,
    operationType: "batch.execute.low_risk",
    input: { batchId },
    reason: "Stale batch revision proof",
    expectedRevision: 1n,
    idempotencyKey: `batch-stale-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(staleExecute.operation.id, principalId);
  await expectRejected(
    admin.apply(staleExecute.operation.id, principalId),
    ADMIN_ERROR_CODES.REVISION_CONFLICT,
  );

  const executePrepared = await admin.prepareMutation({
    principalId,
    operationType: "batch.execute.low_risk",
    input: { batchId },
    reason: "Phase 12.24 execute frozen wallet batch",
    expectedRevision: 0n,
    idempotencyKey: `batch-execute-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (executePrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Low-risk batch execute did not require R3 confirmation");
  }
  await expectRejected(
    admin.apply(executePrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  await admin.confirm(executePrepared.operation.id, principalId);

  const claimed = await batchRepository.claimExecution({
    batchId,
    principalId,
    executeAdminOperationId: executePrepared.operation.id,
    expectedRevision: 0n,
  });
  if (claimed.batch.status !== "RUNNING")
    throw new Error("Batch crash proof did not claim RUNNING");
  const firstTarget = (await batchRepository.loadPendingTargets(batchId, 1))[0];
  if (firstTarget === undefined) throw new Error("Batch crash proof has no pending target");
  await batchRepository.recordAttempt(batchId, firstTarget.ordinal);
  const firstChild = await admin.prepareMutation({
    principalId,
    operationType: claimed.batch.childOperationType,
    input: firstTarget.childInput,
    reason: claimed.batch.reason,
    idempotencyKey: firstTarget.childIdempotencyKey,
    correlationId: claimed.batch.correlationId,
  });
  const firstChildApplied = await admin.apply(firstChild.operation.id, principalId);
  if (firstChildApplied.status !== "APPLIED") throw new Error("Crash proof child did not apply");
  // Simulated process crash: child owner/admin operation committed, batch target result was not.

  const executeApplied = await admin.apply(executePrepared.operation.id, principalId);
  if (
    executeApplied.status !== "APPLIED" ||
    executeApplied.result?.status !== "COMPLETED" ||
    resultNumber(executeApplied.result, "successCount") !== 2 ||
    resultNumber(executeApplied.result, "failureCount") !== 0
  ) {
    throw new Error(
      `Resumed batch did not complete cleanly: ${JSON.stringify(executeApplied.result)}`,
    );
  }

  const balances = await pool.query<{ player_id: string; amount: string }>(
    `SELECT player_id, amount::text FROM wallet_balances
     WHERE currency_id = $1 AND player_id = ANY($2::uuid[])
     ORDER BY player_id`,
    [currencyId, [playerA, playerB, latePlayer]],
  );
  const amountByPlayer = new Map(balances.rows.map((row) => [row.player_id, row.amount]));
  if (
    amountByPlayer.get(playerA) !== "110" ||
    amountByPlayer.get(playerB) !== "110" ||
    amountByPlayer.get(latePlayer) !== "100"
  ) {
    throw new Error(
      `Frozen batch balances are wrong: ${JSON.stringify(Object.fromEntries(amountByPlayer))}`,
    );
  }
  const walletLedger = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wallet_ledger
     WHERE player_id = ANY($1::uuid[]) AND currency_id = $2 AND source_type = 'ADMIN_OPERATION'`,
    [[playerA, playerB], currencyId],
  );
  if (walletLedger.rows[0]?.count !== "2") {
    throw new Error("Crash replay duplicated a wallet ledger mutation");
  }
  const childOperations = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM admin_operations WHERE idempotency_key LIKE $1`,
    [`batch:${batchId}:%`],
  );
  if (childOperations.rows[0]?.count !== "2") {
    throw new Error("Batch did not converge to exactly one child AdminOperation per target");
  }
  const finalBatch = await batchRepository.getBatch(batchId);
  if (
    finalBatch?.status !== "COMPLETED" ||
    finalBatch.checkpointOrdinal !== 1 ||
    finalBatch.revision !== 1n
  ) {
    throw new Error("Batch checkpoint/revision did not reach terminal state exactly once");
  }

  await pool.query(
    `UPDATE wallet_balances SET amount = CASE WHEN player_id = $1 THEN 100 ELSE 0 END
     WHERE currency_id = $3 AND player_id = ANY($2::uuid[])`,
    [playerA, [playerA, playerB], currencyId],
  );
  const partialPreview = await admin.prepareMutation({
    principalId,
    operationType: "batch.preview",
    input: {
      selector: { kind: "PLAYER_IDS", playerIds: [playerA, playerB] },
      action: { kind: "WALLET_ADJUST", currencyId, delta: "-50" },
      chunkSize: 2,
    },
    reason: "Partial domain failure batch proof",
    idempotencyKey: `batch-partial-preview-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  const partialPreviewApplied = await admin.apply(partialPreview.operation.id, principalId);
  const partialBatchId = resultString(partialPreviewApplied.result, "batchId");
  const partialExecute = await admin.prepareMutation({
    principalId,
    operationType: "batch.execute.low_risk",
    input: { batchId: partialBatchId },
    reason: "Partial domain failure execute",
    expectedRevision: 0n,
    idempotencyKey: `batch-partial-execute-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(partialExecute.operation.id, principalId);
  const partialApplied = await admin.apply(partialExecute.operation.id, principalId);
  if (
    partialApplied.result?.status !== "COMPLETED_WITH_ERRORS" ||
    resultNumber(partialApplied.result, "successCount") !== 1 ||
    resultNumber(partialApplied.result, "failureCount") !== 1
  ) {
    throw new Error(
      `Partial batch did not report per-target failure: ${JSON.stringify(partialApplied.result)}`,
    );
  }

  const inventoryPreview = await admin.prepareMutation({
    principalId,
    operationType: "batch.preview",
    input: {
      selector: { kind: "PLAYER_IDS", playerIds: [playerA, playerB] },
      action: { kind: "INVENTORY_ADJUST", itemId, delta: "2" },
      chunkSize: 2,
    },
    reason: "Inventory batch allowlist proof",
    idempotencyKey: `batch-inventory-preview-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  const inventoryBatchId = resultString(
    (await admin.apply(inventoryPreview.operation.id, principalId)).result,
    "batchId",
  );
  const inventoryExecute = await admin.prepareMutation({
    principalId,
    operationType: "batch.execute.low_risk",
    input: { batchId: inventoryBatchId },
    reason: "Inventory batch execute proof",
    expectedRevision: 0n,
    idempotencyKey: `batch-inventory-execute-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(inventoryExecute.operation.id, principalId);
  await admin.apply(inventoryExecute.operation.id, principalId);
  const inventory = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM inventory_balances
     WHERE player_id = ANY($1::uuid[]) AND item_id = $2 AND quantity = 2`,
    [[playerA, playerB], itemId],
  );
  if (inventory.rows[0]?.count !== "2")
    throw new Error("Inventory batch did not hit both frozen targets");

  const progressionPreview = await admin.prepareMutation({
    principalId,
    operationType: "batch.preview",
    input: {
      selector: { kind: "PLAYER_IDS", playerIds: [playerA, playerB] },
      action: { kind: "TRAINER_PROGRESSION_ADJUST", delta: "10" },
      chunkSize: 2,
    },
    reason: "Progression batch allowlist proof",
    idempotencyKey: `batch-progression-preview-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  const progressionBatchId = resultString(
    (await admin.apply(progressionPreview.operation.id, principalId)).result,
    "batchId",
  );
  const progressionExecute = await admin.prepareMutation({
    principalId,
    operationType: "batch.execute.low_risk",
    input: { batchId: progressionBatchId },
    reason: "Progression batch execute proof",
    expectedRevision: 0n,
    idempotencyKey: `batch-progression-execute-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(progressionExecute.operation.id, principalId);
  await admin.apply(progressionExecute.operation.id, principalId);
  const progressionRows = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM trainer_progression
     WHERE player_id = ANY($1::uuid[]) AND progression_points = 10`,
    [[playerA, playerB]],
  );
  if (progressionRows.rows[0]?.count !== "2") {
    throw new Error("Progression batch did not hit both frozen targets");
  }

  console.log("phase12 admin batch proof passed");
} finally {
  await pool.end();
}
