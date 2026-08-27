import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { parsePlayerId } from "../../src/shared-kernel/ids.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

function expectAdminCode(error: unknown, code: string): void {
  if (!(error instanceof AdminError) || error.code !== code) {
    throw error instanceof Error ? error : new Error(`Expected ${code}`);
  }
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const economyRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'ECONOMY_ADMIN'`,
  );
  const roleId = economyRole.rows[0]?.id;
  if (roleId === undefined) throw new Error("Phase 12 ECONOMY_ADMIN role must be seeded");

  const playerId = randomUUID();
  const otherPlayerId = randomUUID();
  const itemId = randomUUID();
  const currencyId = randomUUID();
  const principalId = randomUUID();

  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`, [
    playerId,
    otherPlayerId,
  ]);
  await pool.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [
    itemId,
    `phase12c-item-${itemId}`,
  ]);
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'Phase 12C Coins', FALSE)`,
    [currencyId, `phase12c-currency-${currencyId}`],
  );
  await pool.query(
    `INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES ($1, $2, 10)`,
    [playerId, itemId],
  );
  await pool.query(
    `INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 100)`,
    [playerId, currencyId],
  );
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')`,
    [principalId, `phase12c:economy:${principalId}`],
  );
  await pool.query(
    `INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`,
    [principalId, roleId],
  );
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'PLAYER', $3)`,
    [randomUUID(), principalId, playerId],
  );

  const adminRepository = new PostgresAdminRepository(pool);
  const economy = new EconomyService(new PostgresEconomyRepository(pool));
  const domain = new AdminDomainOperationService(
    economy,
    new PostgresAdminOperationCompletion(pool),
  );
  const registry = registerPhase12CDomainAdminOperations(
    createPhase12AdminOperationRegistry(adminRepository),
    domain,
  );
  const admin = new AdminService(registry, adminRepository);

  const walletPrepared = await admin.prepareMutation({
    principalId,
    operationType: "wallet.adjust",
    input: { playerId, currencyId, delta: "-30" },
    reason: "Correct duplicate support credit",
    idempotencyKey: `wallet-adjust-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (walletPrepared.operation.status !== "READY") {
    throw new Error("R2 wallet adjustment should be READY after validation");
  }
  const walletApplied = await admin.apply(walletPrepared.operation.id, principalId);
  if (walletApplied.status !== "APPLIED" || walletApplied.result?.balanceAfter !== "70") {
    throw new Error("Wallet adjustment did not persist the expected admin result");
  }
  const walletReplay = await admin.apply(walletPrepared.operation.id, principalId);
  if (walletReplay.id !== walletApplied.id || walletReplay.result?.balanceAfter !== "70") {
    throw new Error("Applied admin wallet operation did not replay deterministically");
  }
  const walletBalance = await pool.query<{ amount: string }>(
    `SELECT amount::text FROM wallet_balances WHERE player_id = $1 AND currency_id = $2`,
    [playerId, currencyId],
  );
  if (walletBalance.rows[0]?.amount !== "70") {
    throw new Error("Wallet admin operation mutated balance more than once");
  }

  const underflow = await admin.prepareMutation({
    principalId,
    operationType: "wallet.adjust",
    input: { playerId, currencyId, delta: "-1000" },
    reason: "Underflow rejection proof",
    idempotencyKey: `wallet-underflow-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.apply(underflow.operation.id, principalId).then(
    () => {
      throw new Error("Wallet underflow should have been rejected");
    },
    (error: unknown) => expectAdminCode(error, ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED),
  );
  const underflowState = await pool.query<{ amount: string; ledger_count: string }>(
    `SELECT balance.amount::text AS amount,
            (SELECT count(*)::text FROM wallet_ledger WHERE source_id = $3) AS ledger_count
     FROM wallet_balances balance
     WHERE balance.player_id = $1 AND balance.currency_id = $2`,
    [playerId, currencyId, underflow.operation.id],
  );
  if (underflowState.rows[0]?.amount !== "70" || underflowState.rows[0]?.ledger_count !== "0") {
    throw new Error("Rejected wallet underflow left partial economy state");
  }

  await admin
    .prepareMutation({
      principalId,
      operationType: "inventory.adjust",
      input: { playerId: otherPlayerId, itemId, delta: "1" },
      reason: "BOLA scope proof",
      idempotencyKey: `inventory-bola-${randomUUID()}`,
      correlationId: randomUUID(),
    })
    .then(
      () => {
        throw new Error("Subject-scoped economy admin must not enumerate another player");
      },
      (error: unknown) => expectAdminCode(error, ADMIN_ERROR_CODES.AUTHORIZATION_DENIED),
    );

  await admin
    .prepareMutation({
      principalId,
      operationType: "inventory.adjust",
      input: { playerId, itemId, delta: "1", quantity: "999" },
      reason: "Mass assignment proof",
      idempotencyKey: `inventory-mass-${randomUUID()}`,
      correlationId: randomUUID(),
    })
    .then(
      () => {
        throw new Error("Strict admin schema accepted an unallowlisted property");
      },
      (error: unknown) => expectAdminCode(error, ADMIN_ERROR_CODES.INVALID_INPUT),
    );

  const crashWindow = await admin.prepareMutation({
    principalId,
    operationType: "inventory.adjust",
    input: { playerId, itemId, delta: "5" },
    reason: "Crash-window reconstruction proof",
    idempotencyKey: `inventory-crash-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  const parsedPlayerId = parsePlayerId(playerId);
  if (!parsedPlayerId.ok) throw new Error("Generated player id failed parser");
  const ownerFirst = await economy.addItem({
    playerId: parsedPlayerId.value,
    itemId,
    quantity: 5n,
    idempotencyKey: crashWindow.operation.id,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: crashWindow.operation.id,
      reason: crashWindow.operation.reason ?? "",
      actorType: "ADMIN",
      actorId: crashWindow.operation.principalId,
      correlationId: crashWindow.operation.correlationId,
    },
  });
  if (!ownerFirst.ok || ownerFirst.value.quantity !== 15n || ownerFirst.value.replayed) {
    throw new Error("Owner-side crash-window setup failed");
  }
  const intervening = await economy.addItem({
    playerId: parsedPlayerId.value,
    itemId,
    quantity: 2n,
    idempotencyKey: `intervening-${randomUUID()}`,
    metadata: {
      sourceType: "PROOF",
      sourceId: randomUUID(),
      reason: "Intervening economy mutation",
      actorType: "SYSTEM",
      actorId: null,
      correlationId: randomUUID(),
    },
  });
  if (!intervening.ok || intervening.value.quantity !== 17n) {
    throw new Error("Intervening economy mutation failed");
  }

  const recovered = await admin.apply(crashWindow.operation.id, principalId);
  if (
    recovered.status !== "APPLIED" ||
    recovered.result?.balanceAfter !== "15" ||
    recovered.result?.ownerReplayed !== true
  ) {
    throw new Error("Admin recovery did not use the original durable owner result");
  }
  const reconstruction = await pool.query<{
    current_quantity: string;
    ledger_balance_after: string | null;
    before_quantity: string | null;
    after_quantity: string | null;
    change_count: string;
    audit_count: string;
  }>(
    `SELECT balance.quantity::text AS current_quantity,
            ledger.balance_after::text AS ledger_balance_after,
            change.before_data ->> 'quantity' AS before_quantity,
            change.after_data ->> 'quantity' AS after_quantity,
            (SELECT count(*)::text FROM admin_operation_changes WHERE admin_operation_id = $3) AS change_count,
            (SELECT count(*)::text FROM audit_events WHERE causation_id = $3) AS audit_count
     FROM inventory_balances balance
     JOIN inventory_ledger ledger ON ledger.source_id = $3
     JOIN admin_operation_changes change ON change.admin_operation_id = $3
     WHERE balance.player_id = $1 AND balance.item_id = $2`,
    [playerId, itemId, crashWindow.operation.id],
  );
  const reconstructionRow = reconstruction.rows[0];
  if (
    reconstructionRow?.current_quantity !== "17" ||
    reconstructionRow.ledger_balance_after !== "15" ||
    reconstructionRow.before_quantity !== "10" ||
    reconstructionRow.after_quantity !== "15" ||
    reconstructionRow.change_count !== "1" ||
    reconstructionRow.audit_count !== "1"
  ) {
    throw new Error("Crash-window evidence reconstruction is not stable");
  }

  console.log(
    "Phase 12C economy admin proof complete: owner delegation, R2 policy, strict scope/schema, underflow rollback, idempotent replay and crash-window evidence verified",
  );
} finally {
  await pool.end();
}
