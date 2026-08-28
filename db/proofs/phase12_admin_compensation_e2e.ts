import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AdminOperationAuditService } from "../../src/modules/admin/audit-service.js";
import { registerPhase12CompensationOperation } from "../../src/modules/admin/compensation-definitions.js";
import { AdminCompensationService } from "../../src/modules/admin/compensation-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { RulesetConfigSchema } from "../../src/modules/catalog/contracts.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import { parsePlayerId } from "../../src/shared-kernel/ids.js";
import { PostgresAdminOperationAuditRepository } from "../../src/platform/admin/postgres-admin-audit-repository.js";
import { PostgresAdminCompensationCompletion } from "../../src/platform/admin/postgres-admin-compensation-completion.js";
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

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const rulesConfig = RulesetConfigSchema.parse({
    schemaVersion: 1,
    battle: {
      statModel: "SIX_STATS",
      physicalSpecialByMove: true,
      ivEnabled: true,
      evEnabled: true,
      natureEnabled: true,
      maxMoves: 4,
      ppEnabled: true,
      criticalMultiplierBasisPoints: 15_000,
      accuracyEvasionEnabled: true,
    },
    capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 10_000 },
    defeat: { automaticMoneyLoss: false },
    narrative: { authority: "N0_FLAVOR_ONLY" },
    progression: {
      pokemon: {
        xpCurve: "CUBIC_DELTA_V1",
        battleRewardModel: "BASE_EXP_LEVEL_DIV_7_V1",
        rewardRecipient: "ACTIVE_WINNER_V1",
        levelCap: 100,
        hpOnLevelUp: "ADD_MAX_HP_DELTA_IF_ALIVE_V1",
        fullMoveSlotsPolicy: "PENDING_CHOICE_V1",
        autoLevelEvolution: true,
      },
      trainer: {
        visiblePointsName: "Insígnia",
        levelCurve: "LINEAR_100_V1",
        levelCap: 100,
        pointsPerWonBattle: 100,
        unlocks: [{ level: 10, unlockKey: "tournament.eligible" }],
      },
    },
  });
  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, $3::jsonb, 'DRAFT')`,
    [rulesetId, `phase12-comp-rules-${rulesetId}`, JSON.stringify(rulesConfig)],
  );
  await pool.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"proof":true}'::jsonb, config_fingerprint = repeat('e', 64)
     WHERE id = $1`,
    [rulesetId],
  );
  await pool.query(`UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
    rulesetId,
  ]);
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 900019, 'Phase 12 compensation proof', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await pool.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"proof":true}'::jsonb, content_fingerprint = repeat('f', 64)
     WHERE id = $1`,
    [releaseId],
  );
  await pool.query(
    `UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [releaseId],
  );
  await pool.query(
    `INSERT INTO content_release_pointers(pointer_key, content_release_id)
     VALUES ('ACTIVE', $1)
     ON CONFLICT (pointer_key) DO UPDATE
     SET content_release_id = EXCLUDED.content_release_id,
         revision = content_release_pointers.revision + 1,
         updated_at = now()`,
    [releaseId],
  );

  const seniorRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SENIOR_ADMIN'`,
  );
  const economyRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'ECONOMY_ADMIN'`,
  );
  const seniorRoleId = seniorRole.rows[0]?.id;
  const economyRoleId = economyRole.rows[0]?.id;
  if (seniorRoleId === undefined || economyRoleId === undefined) {
    throw new Error("Compensation proof requires seeded SENIOR_ADMIN and ECONOMY_ADMIN roles");
  }

  const playerId = randomUUID();
  const otherPlayerId = randomUUID();
  const itemId = randomUUID();
  const currencyId = randomUUID();
  const unsafeCurrencyId = randomUUID();
  const seniorId = randomUUID();
  const economyOnlyId = randomUUID();

  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`, [
    playerId,
    otherPlayerId,
  ]);
  await pool.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [
    itemId,
    `phase12-comp-item-${itemId}`,
  ]);
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'Comp Proof Coins', FALSE),
            ($3, $4, 'Unsafe Comp Coins', FALSE)`,
    [
      currencyId,
      `phase12-comp-currency-${currencyId}`,
      unsafeCurrencyId,
      `phase12-comp-unsafe-${unsafeCurrencyId}`,
    ],
  );
  await pool.query(
    `INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES ($1, $2, 10)`,
    [playerId, itemId],
  );
  await pool.query(
    `INSERT INTO wallet_balances(player_id, currency_id, amount)
     VALUES ($1, $2, 100), ($1, $3, 0)`,
    [playerId, currencyId, unsafeCurrencyId],
  );
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE')`,
    [
      seniorId,
      `phase12:comp:senior:${seniorId}`,
      economyOnlyId,
      `phase12:comp:economy:${economyOnlyId}`,
    ],
  );
  await pool.query(
    `INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2), ($3, $4)`,
    [seniorId, seniorRoleId, economyOnlyId, economyRoleId],
  );
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'PLAYER', $3), ($4, $5, 'PLAYER', $3)`,
    [randomUUID(), seniorId, playerId, randomUUID(), economyOnlyId],
  );

  const adminRepository = new PostgresAdminRepository(pool);
  const economy = new EconomyService(new PostgresEconomyRepository(pool));
  const progression = new ProgressionService(new PostgresProgressionRepository(pool));
  const domain = new AdminDomainOperationService(
    economy,
    progression,
    new PostgresAdminOperationCompletion(pool),
  );
  const registry = registerPhase12CDomainAdminOperations(
    createPhase12AdminOperationRegistry(adminRepository),
    domain,
  );
  const compensation = new AdminCompensationService(
    adminRepository,
    economy,
    progression,
    new PostgresAdminCompensationCompletion(pool),
  );
  registerPhase12CompensationOperation(registry, compensation);
  const admin = new AdminService(registry, adminRepository);
  const audit = new AdminOperationAuditService(
    admin,
    new PostgresAdminOperationAuditRepository(pool),
  );

  const prepareAndApplySource = async (
    operationType: "wallet.adjust" | "inventory.adjust" | "progression.trainer.adjust",
    input: Record<string, unknown>,
  ) => {
    const prepared = await admin.prepareMutation({
      principalId: seniorId,
      operationType,
      input,
      reason: `Compensation source proof for ${operationType}`,
      idempotencyKey: `source-${operationType}-${randomUUID()}`,
      correlationId: randomUUID(),
    });
    const applied = await admin.apply(prepared.operation.id, seniorId);
    if (applied.status !== "APPLIED") throw new Error(`${operationType} source did not apply`);
    return applied;
  };

  const prepareCompensation = async (sourceOperationId: string) => {
    const prepared = await admin.prepareMutation({
      principalId: seniorId,
      operationType: "admin.operation.compensate",
      input: { sourceOperationId, playerId },
      reason: "Explicit semantic compensation proof",
      idempotencyKey: `compensate-${randomUUID()}`,
      correlationId: randomUUID(),
    });
    if (prepared.operation.status !== "PENDING_CONFIRMATION") {
      throw new Error("Compensation must require explicit R3 confirmation");
    }
    await expectRejected(
      admin.apply(prepared.operation.id, seniorId),
      ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
    );
    await admin.confirm(prepared.operation.id, seniorId);
    return prepared.operation;
  };

  const walletSource = await prepareAndApplySource("wallet.adjust", {
    playerId,
    currencyId,
    delta: "20",
  });
  const walletComp = await prepareCompensation(walletSource.id);

  const parsedPlayer = parsePlayerId(playerId);
  if (!parsedPlayer.ok) throw new Error("Compensation proof player id failed parser");
  const ownerFirst = await economy.debitWallet({
    playerId: parsedPlayer.value,
    currencyId,
    amount: 20n,
    idempotencyKey: walletComp.id,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: walletComp.id,
      reason: walletComp.reason ?? "",
      actorType: "ADMIN",
      actorId: seniorId,
      correlationId: walletComp.correlationId,
    },
  });
  if (!ownerFirst.ok || ownerFirst.value.replayed || ownerFirst.value.amount !== 100n) {
    throw new Error("Compensation crash-window owner mutation did not commit exactly once");
  }
  const walletCompApplied = await admin.apply(walletComp.id, seniorId);
  if (
    walletCompApplied.status !== "APPLIED" ||
    walletCompApplied.result?.ownerReplayed !== true ||
    walletCompApplied.result?.compensatesOperationId !== walletSource.id
  ) {
    throw new Error("Compensation crash recovery did not replay the owner exactly once");
  }
  const walletSourceAfter = await adminRepository.getOperation(walletSource.id);
  if (walletSourceAfter?.status !== "COMPENSATED") {
    throw new Error("Successful compensation did not mark the source COMPENSATED");
  }
  const walletEvidence = await pool.query<{
    amount: string;
    source_ledgers: string;
    compensation_ledgers: string;
    relations: string;
  }>(
    `SELECT balance.amount::text AS amount,
            (SELECT count(*)::text FROM wallet_ledger WHERE source_id = $3) AS source_ledgers,
            (SELECT count(*)::text FROM wallet_ledger WHERE source_id = $4) AS compensation_ledgers,
            (SELECT count(*)::text FROM admin_operation_compensations
             WHERE source_admin_operation_id = $3::uuid
               AND compensation_admin_operation_id = $4::uuid) AS relations
     FROM wallet_balances balance
     WHERE balance.player_id = $1 AND balance.currency_id = $2`,
    [playerId, currencyId, walletSource.id, walletComp.id],
  );
  if (
    walletEvidence.rows[0]?.amount !== "100" ||
    walletEvidence.rows[0]?.source_ledgers !== "1" ||
    walletEvidence.rows[0]?.compensation_ledgers !== "1" ||
    walletEvidence.rows[0]?.relations !== "1"
  ) {
    throw new Error("Wallet compensation did not preserve exactly-once ledger/link evidence");
  }

  const sourceTrail = await audit.inspect({ principalId: seniorId, operationId: walletSource.id });
  const compTrail = await audit.inspect({ principalId: seniorId, operationId: walletComp.id });
  if (
    sourceTrail.ownerEvidence.filter((entry) => entry.source === "ADMIN_COMPENSATION").length !== 1 ||
    compTrail.ownerEvidence.filter((entry) => entry.source === "ADMIN_COMPENSATION").length !== 1
  ) {
    throw new Error("Compensation relation is not reconstructable from both audit directions");
  }

  const secondComp = await prepareCompensation(walletSource.id);
  await expectRejected(
    admin.apply(secondComp.id, seniorId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  const compensateCompensation = await prepareCompensation(walletComp.id);
  await expectRejected(
    admin.apply(compensateCompensation.id, seniorId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  const inventorySource = await prepareAndApplySource("inventory.adjust", {
    playerId,
    itemId,
    delta: "5",
  });
  const inventoryComp = await prepareCompensation(inventorySource.id);
  await admin.apply(inventoryComp.id, seniorId);
  const inventoryState = await pool.query<{ quantity: string }>(
    `SELECT quantity::text FROM inventory_balances WHERE player_id = $1 AND item_id = $2`,
    [playerId, itemId],
  );
  if (inventoryState.rows[0]?.quantity !== "10") {
    throw new Error("Inventory compensation did not restore the semantic prior quantity");
  }

  const progressionSource = await prepareAndApplySource("progression.trainer.adjust", {
    playerId,
    delta: "900",
  });
  const progressionComp = await prepareCompensation(progressionSource.id);
  await admin.apply(progressionComp.id, seniorId);
  const progressionState = await pool.query<{ points: string }>(
    `SELECT progression_points::text AS points FROM trainer_progression WHERE player_id = $1`,
    [playerId],
  );
  if (progressionState.rows[0]?.points !== "0") {
    throw new Error("Trainer progression compensation did not restore points to zero");
  }

  const unsafeSource = await prepareAndApplySource("wallet.adjust", {
    playerId,
    currencyId: unsafeCurrencyId,
    delta: "10",
  });
  await prepareAndApplySource("wallet.adjust", {
    playerId,
    currencyId: unsafeCurrencyId,
    delta: "-10",
  });
  const unsafeComp = await prepareCompensation(unsafeSource.id);
  await expectRejected(
    admin.apply(unsafeComp.id, seniorId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );
  const unsafeState = await pool.query<{
    amount: string;
    source_status: string;
    comp_status: string;
    relation_count: string;
    compensation_ledgers: string;
  }>(
    `SELECT balance.amount::text AS amount,
            source.status AS source_status,
            compensation.status AS comp_status,
            (SELECT count(*)::text FROM admin_operation_compensations
             WHERE source_admin_operation_id = $3::uuid) AS relation_count,
            (SELECT count(*)::text FROM wallet_ledger WHERE source_id = $4) AS compensation_ledgers
     FROM wallet_balances balance
     JOIN admin_operations source ON source.id = $3::uuid
     JOIN admin_operations compensation ON compensation.id = $4::uuid
     WHERE balance.player_id = $1 AND balance.currency_id = $2`,
    [playerId, unsafeCurrencyId, unsafeSource.id, unsafeComp.id],
  );
  if (
    unsafeState.rows[0]?.amount !== "0" ||
    unsafeState.rows[0]?.source_status !== "APPLIED" ||
    unsafeState.rows[0]?.comp_status !== "READY" ||
    unsafeState.rows[0]?.relation_count !== "0" ||
    unsafeState.rows[0]?.compensation_ledgers !== "0"
  ) {
    throw new Error("Unsafe inverse was forced or left partial compensation evidence");
  }

  await expectRejected(
    admin.prepareMutation({
      principalId: economyOnlyId,
      operationType: "admin.operation.compensate",
      input: { sourceOperationId: unsafeSource.id, playerId },
      reason: "Dedicated capability denial proof",
      idempotencyKey: `denied-comp-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );
  await expectRejected(
    admin.prepareMutation({
      principalId: seniorId,
      operationType: "admin.operation.compensate",
      input: { sourceOperationId: unsafeSource.id, playerId, delta: "999999" },
      reason: "Mass assignment compensation proof",
      idempotencyKey: `mass-comp-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.INVALID_INPUT,
  );
  await expectRejected(
    admin.prepareMutation({
      principalId: seniorId,
      operationType: "admin.operation.compensate",
      input: { sourceOperationId: unsafeSource.id, playerId: otherPlayerId },
      reason: "Compensation BOLA proof",
      idempotencyKey: `bola-comp-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  await pool
    .query(
      `UPDATE admin_operation_compensations SET compensation_kind = 'INVERSE_DELTA_V1'
       WHERE source_admin_operation_id = $1`,
      [walletSource.id],
    )
    .then(
      () => {
        throw new Error("Append-only compensation relation accepted UPDATE");
      },
      () => undefined,
    );

  console.log(
    "phase12 admin compensation proof passed: explicit inverse deltas, R3/capability/scope, crash replay, unsafe inverse rejection, one-shot source relation and audit reconstruction verified",
  );
} finally {
  await pool.end();
}
