import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { EconomyService } from "../../src/modules/economy/service.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function metadata(sourceId: string) {
  return {
    sourceType: "PHASE16_FUZZ",
    sourceId,
    reason: `phase16 economy fuzz ${sourceId}`,
    actorType: "SYSTEM" as const,
    actorId: null,
    correlationId: randomUUID(),
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 16 });
try {
  const playerId = createPlayerId();
  const itemId = randomUUID();
  const currencyId = randomUUID();

  await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  await pool.query("INSERT INTO items(id, slug) VALUES ($1, $2)", [
    itemId,
    `phase16-fuzz-item-${itemId}`,
  ]);
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'Phase 16 Fuzz Currency', FALSE)`,
    [currencyId, `phase16-fuzz-currency-${currencyId}`],
  );

  const service = new EconomyService(new PostgresEconomyRepository(pool));
  let expectedInventory = 10_000n;
  let expectedWallet = 100_000n;

  unwrap(
    await service.addItem({
      playerId,
      itemId,
      quantity: expectedInventory,
      idempotencyKey: "phase16-fuzz-initial-inventory",
      metadata: metadata("initial-inventory"),
    }),
  );
  unwrap(
    await service.creditWallet({
      playerId,
      currencyId,
      amount: expectedWallet,
      idempotencyKey: "phase16-fuzz-initial-wallet",
      metadata: metadata("initial-wallet"),
    }),
  );

  const replayOperations: Array<() => Promise<{ replayed: boolean }>> = [];
  let inventoryMutations = 1;
  let walletMutations = 1;
  const operations = 1_000;

  for (let index = 0; index < operations; index += 1) {
    const amount = BigInt((index % 5) + 1);
    const idempotencyKey = `phase16-economy-fuzz-${index}`;
    const audit = metadata(`mutation-${index}`);
    const operation = index % 4;

    if (operation === 0) {
      const execute = async () =>
        unwrap(
          await service.addItem({
            playerId,
            itemId,
            quantity: amount,
            idempotencyKey,
            metadata: audit,
          }),
        );
      const result = await execute();
      if (result.replayed) throw new Error("Fresh inventory add unexpectedly replayed");
      expectedInventory += amount;
      inventoryMutations += 1;
      if (index % 40 === 0) replayOperations.push(execute);
    } else if (operation === 1) {
      const execute = async () =>
        unwrap(
          await service.consumeItem({
            playerId,
            itemId,
            quantity: amount,
            idempotencyKey,
            metadata: audit,
          }),
        );
      const result = await execute();
      if (result.replayed) throw new Error("Fresh inventory consume unexpectedly replayed");
      expectedInventory -= amount;
      inventoryMutations += 1;
      if (index % 40 === 1) replayOperations.push(execute);
    } else if (operation === 2) {
      const execute = async () =>
        unwrap(
          await service.creditWallet({
            playerId,
            currencyId,
            amount,
            idempotencyKey,
            metadata: audit,
          }),
        );
      const result = await execute();
      if (result.replayed) throw new Error("Fresh wallet credit unexpectedly replayed");
      expectedWallet += amount;
      walletMutations += 1;
      if (index % 40 === 2) replayOperations.push(execute);
    } else {
      const execute = async () =>
        unwrap(
          await service.debitWallet({
            playerId,
            currencyId,
            amount,
            idempotencyKey,
            metadata: audit,
          }),
        );
      const result = await execute();
      if (result.replayed) throw new Error("Fresh wallet debit unexpectedly replayed");
      expectedWallet -= amount;
      walletMutations += 1;
      if (index % 40 === 3) replayOperations.push(execute);
    }

    if ((index + 1) % 100 === 0) {
      const inventory = unwrap(await service.getInventoryBalance(playerId, itemId));
      const wallet = unwrap(await service.getWalletBalance(playerId, currencyId));
      if (inventory !== expectedInventory || wallet !== expectedWallet) {
        throw new Error(`Reference model diverged after ${index + 1} mutations`);
      }
    }
  }

  const inventoryBeforeReplay = unwrap(await service.getInventoryBalance(playerId, itemId));
  const walletBeforeReplay = unwrap(await service.getWalletBalance(playerId, currencyId));
  for (const replay of replayOperations) {
    const result = await replay();
    if (!result.replayed) throw new Error("Repeated economy mutation did not replay");
  }
  const inventoryAfterReplay = unwrap(await service.getInventoryBalance(playerId, itemId));
  const walletAfterReplay = unwrap(await service.getWalletBalance(playerId, currencyId));
  if (inventoryAfterReplay !== inventoryBeforeReplay || walletAfterReplay !== walletBeforeReplay) {
    throw new Error("Idempotent replay changed an economy balance");
  }

  const ledgerState = await pool.query<{
    inventory_count: string;
    inventory_missing_audit: string;
    wallet_count: string;
    wallet_missing_audit: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM inventory_ledger WHERE player_id = $1) AS inventory_count,
       (SELECT count(*)::text FROM inventory_ledger
          WHERE player_id = $1 AND (reason IS NULL OR correlation_id IS NULL)) AS inventory_missing_audit,
       (SELECT count(*)::text FROM wallet_ledger WHERE player_id = $1) AS wallet_count,
       (SELECT count(*)::text FROM wallet_ledger
          WHERE player_id = $1 AND (reason IS NULL OR correlation_id IS NULL)) AS wallet_missing_audit`,
    [playerId],
  );
  const row = ledgerState.rows[0];
  if (
    row?.inventory_count !== String(inventoryMutations) ||
    row.inventory_missing_audit !== "0" ||
    row.wallet_count !== String(walletMutations) ||
    row.wallet_missing_audit !== "0"
  ) {
    throw new Error(`Economy fuzz ledger invariant failed: ${JSON.stringify(row)}`);
  }

  if (inventoryAfterReplay !== expectedInventory || walletAfterReplay !== expectedWallet) {
    throw new Error("Final economy balances diverged from deterministic reference model");
  }

  console.log(
    JSON.stringify({
      status: "PHASE16_ECONOMY_FUZZ_OK",
      operations,
      replays: replayOperations.length,
      inventoryMutations,
      walletMutations,
      inventory: inventoryAfterReplay.toString(),
      wallet: walletAfterReplay.toString(),
    }),
  );
} finally {
  await pool.end();
}
