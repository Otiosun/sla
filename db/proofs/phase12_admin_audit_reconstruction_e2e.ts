import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AdminOperationAuditService } from "../../src/modules/admin/audit-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import { PostgresAdminOperationAuditRepository } from "../../src/platform/admin/postgres-admin-audit-repository.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";
import { parsePlayerId } from "../../src/shared-kernel/ids.js";

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
  const ownerRoleResult = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'OWNER_SECURITY_ADMIN'`,
  );
  const economyRoleResult = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'ECONOMY_ADMIN'`,
  );
  const supportRoleResult = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SUPPORT'`,
  );
  const ownerRoleId = ownerRoleResult.rows[0]?.id;
  const economyRoleId = economyRoleResult.rows[0]?.id;
  const supportRoleId = supportRoleResult.rows[0]?.id;
  if (ownerRoleId === undefined || economyRoleId === undefined || supportRoleId === undefined) {
    throw new Error("Phase 12 admin roles must be seeded");
  }

  const proposerId = randomUUID();
  const approverId = randomUUID();
  const economyOnlyId = randomUUID();
  const targetAdminId = randomUUID();
  const playerIdRaw = randomUUID();
  const currencyId = randomUUID();

  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE'), ($5, $6, 'ACTIVE'), ($7, $8, 'ACTIVE')`,
    [
      proposerId,
      `phase12:audit:proposer:${proposerId}`,
      approverId,
      `phase12:audit:approver:${approverId}`,
      economyOnlyId,
      `phase12:audit:economy:${economyOnlyId}`,
      targetAdminId,
      `phase12:audit:target:${targetAdminId}`,
    ],
  );
  await pool.query(
    `INSERT INTO admin_principal_roles(principal_id, role_id)
     VALUES ($1, $4), ($2, $4), ($3, $5)`,
    [proposerId, approverId, economyOnlyId, ownerRoleId, economyRoleId],
  );
  for (const principalId of [proposerId, approverId, economyOnlyId]) {
    await pool.query(
      `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
       VALUES ($1, $2, 'GLOBAL', NULL)`,
      [randomUUID(), principalId],
    );
  }

  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [playerIdRaw]);
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'Audit Proof Coins', FALSE)`,
    [currencyId, `phase12-audit-currency-${currencyId}`],
  );
  await pool.query(
    `INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 100)`,
    [playerIdRaw, currencyId],
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
  const audit = new AdminOperationAuditService(
    admin,
    new PostgresAdminOperationAuditRepository(pool),
  );

  const rolePrepared = await admin.prepareMutation({
    principalId: proposerId,
    operationType: "admin.role.assign",
    input: { principalId: targetAdminId, roleId: supportRoleId },
    reason: "R4 audit reconstruction proof",
    expectedRevision: 0n,
    idempotencyKey: `audit-r4-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.simulate(rolePrepared.operation.id, proposerId);
  await admin.confirm(rolePrepared.operation.id, proposerId);
  await admin.approve(rolePrepared.operation.id, approverId, "independent audit proof approval");
  const roleApplied = await admin.apply(rolePrepared.operation.id, proposerId);
  if (roleApplied.status !== "APPLIED") throw new Error("R4 audit proof operation did not apply");

  await expectRejected(
    audit.inspect({ principalId: economyOnlyId, operationId: rolePrepared.operation.id }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  const r4Trail = await audit.inspect({
    principalId: proposerId,
    operationId: rolePrepared.operation.id,
  });
  if (
    r4Trail.operation.status !== "APPLIED" ||
    r4Trail.operation.operationType !== "admin.role.assign" ||
    r4Trail.operation.riskTier !== 4 ||
    r4Trail.operation.targetId !== targetAdminId ||
    r4Trail.operation.reason !== "R4 audit reconstruction proof" ||
    r4Trail.operation.policy.requiresSimulation !== true ||
    r4Trail.operation.policy.requiresConfirmation !== true ||
    r4Trail.operation.policy.requiredApprovals !== 1
  ) {
    throw new Error("R4 operation snapshot is insufficient for reconstruction");
  }
  if (
    r4Trail.confirmations.length !== 1 ||
    r4Trail.confirmations[0]?.principalId !== proposerId ||
    r4Trail.confirmations[0]?.requestFingerprint !== r4Trail.operation.requestFingerprint
  ) {
    throw new Error("R4 confirmation evidence is incomplete");
  }
  if (
    r4Trail.approvals.length !== 1 ||
    r4Trail.approvals[0]?.principalId !== approverId ||
    r4Trail.approvals[0]?.decision !== "APPROVED" ||
    r4Trail.approvals[0]?.requestFingerprint !== r4Trail.operation.requestFingerprint
  ) {
    throw new Error("R4 approval evidence is incomplete");
  }
  const r4Change = r4Trail.changes[0];
  const r4Event = r4Trail.auditEvents[0];
  if (
    r4Trail.changes.length !== 1 ||
    r4Change?.resourceType !== "ADMIN_PRINCIPAL" ||
    r4Change.resourceId !== targetAdminId ||
    r4Trail.auditEvents.length !== 1 ||
    r4Event?.actorId !== proposerId ||
    r4Event.action !== "admin.role.assign" ||
    r4Event.correlationId !== r4Trail.operation.correlationId ||
    r4Event.causationId !== r4Trail.operation.id ||
    r4Event.metadata.adminOperationId !== r4Trail.operation.id ||
    r4Event.metadata.requestFingerprint !== r4Trail.operation.requestFingerprint
  ) {
    throw new Error("R4 before/after/audit correlation evidence is incomplete");
  }

  const walletPrepared = await admin.prepareMutation({
    principalId: proposerId,
    operationType: "wallet.adjust",
    input: { playerId: playerIdRaw, currencyId, delta: "25" },
    reason: "wallet owner crash-window audit proof",
    idempotencyKey: `audit-wallet-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (walletPrepared.operation.status !== "READY") {
    throw new Error("Wallet audit proof operation did not prepare READY");
  }
  const parsedPlayerId = parsePlayerId(playerIdRaw);
  if (!parsedPlayerId.ok) throw new Error("Audit proof player id is invalid");
  const ownerCommit = await economy.creditWallet({
    playerId: parsedPlayerId.value,
    currencyId,
    amount: 25n,
    idempotencyKey: walletPrepared.operation.id,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: walletPrepared.operation.id,
      reason: "wallet owner crash-window audit proof",
      actorType: "ADMIN",
      actorId: proposerId,
      correlationId: walletPrepared.operation.correlationId,
    },
  });
  if (!ownerCommit.ok || ownerCommit.value.replayed) {
    throw new Error("Wallet owner crash-window fixture did not commit exactly once");
  }

  const crashTrail = await audit.inspect({
    principalId: proposerId,
    operationId: walletPrepared.operation.id,
  });
  const crashLedger = crashTrail.ownerEvidence.filter((item) => item.source === "WALLET_LEDGER");
  if (
    crashTrail.operation.status !== "READY" ||
    crashTrail.changes.length !== 0 ||
    crashTrail.auditEvents.length !== 0 ||
    crashLedger.length !== 1 ||
    crashLedger[0]?.correlationId !== walletPrepared.operation.correlationId ||
    crashLedger[0]?.evidence.delta !== "25"
  ) {
    throw new Error("Audit inspector cannot reconstruct owner-committed crash window");
  }

  const recovered = await admin.apply(walletPrepared.operation.id, proposerId);
  if (recovered.status !== "APPLIED") throw new Error("Wallet crash recovery did not complete");
  const recoveredTrail = await audit.inspect({
    principalId: proposerId,
    operationId: walletPrepared.operation.id,
  });
  const recoveredLedger = recoveredTrail.ownerEvidence.filter(
    (item) => item.source === "WALLET_LEDGER",
  );
  if (
    recoveredTrail.operation.status !== "APPLIED" ||
    recoveredTrail.changes.length !== 1 ||
    recoveredTrail.auditEvents.length !== 1 ||
    recoveredLedger.length !== 1 ||
    recoveredTrail.operation.result?.ownerReplayed !== true
  ) {
    throw new Error("Recovered wallet operation trail did not converge to one reconstructable history");
  }
  const walletState = await pool.query<{ amount: string; ledgers: string }>(
    `SELECT balance.amount::text,
            (SELECT count(*)::text FROM wallet_ledger ledger
             WHERE ledger.player_id = balance.player_id
               AND ledger.currency_id = balance.currency_id
               AND ledger.source_type = 'ADMIN_OPERATION'
               AND ledger.source_id = $3) AS ledgers
     FROM wallet_balances balance
     WHERE balance.player_id = $1 AND balance.currency_id = $2`,
    [playerIdRaw, currencyId, walletPrepared.operation.id],
  );
  if (walletState.rows[0]?.amount !== "125" || walletState.rows[0]?.ledgers !== "1") {
    throw new Error("Audit proof recovery duplicated or lost the owner mutation");
  }

  await expectRejected(
    audit.inspect({ principalId: proposerId, operationId: randomUUID() }),
    ADMIN_ERROR_CODES.OPERATION_NOT_FOUND,
  );
  await expectRejected(
    audit.inspect({
      principalId: proposerId,
      operationId: rolePrepared.operation.id,
      injected: "mass-assignment",
    }),
    ADMIN_ERROR_CODES.INVALID_INPUT,
  );

  console.log(
    "phase12 admin audit reconstruction proof passed: R4 gates/before-after/correlation and owner-commit crash window are support-reconstructable",
  );
} finally {
  await pool.end();
}
