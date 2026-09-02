import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { PostgresEconomyAnalyticsRepository } from "../../src/platform/admin/postgres-economy-analytics-repository.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for the F8.3 economy analytics performance proof");
  }
  return value;
})();

const PLAYER_COUNT = 1_500;
const CURRENCY_COUNT = 8;
const ITEM_COUNT = 12;
const EXPLAIN_BUDGET_MS = 750;
const SEQUENTIAL_BUDGET_MS = 1_250;
const CONCURRENT_BUDGET_MS = 5_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function executionTimeMs(plan: unknown): number {
  if (!Array.isArray(plan)) throw new Error("EXPLAIN JSON did not return an array");
  const root = plan[0];
  if (typeof root !== "object" || root === null || !("Execution Time" in root)) {
    throw new Error(`EXPLAIN ANALYZE did not expose Execution Time: ${JSON.stringify(plan)}`);
  }
  const value = (root as { readonly "Execution Time": unknown })["Execution Time"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid EXPLAIN execution time: ${String(value)}`);
  }
  return value;
}

async function seedEconomyFixture(pool: Pool): Promise<void> {
  const players = await pool.query<{ id: string }>(
    `SELECT player.id
     FROM players player
     JOIN player_profiles profile ON profile.player_id = player.id
     WHERE profile.trainer_name LIKE 'Perf-%'
     ORDER BY player.created_at DESC, player.id DESC
     LIMIT $1`,
    [PLAYER_COUNT],
  );
  const playerIds = players.rows.map((row) => row.id);
  assert(playerIds.length === PLAYER_COUNT, `Expected ${PLAYER_COUNT} performance players`);

  const currencyIds = Array.from({ length: CURRENCY_COUNT }, () => randomUUID());
  const itemIds = Array.from({ length: ITEM_COUNT }, () => randomUUID());

  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     SELECT id,
            'f8-3-perf-' || lpad(ordinality::text, 2, '0'),
            'F8.3 Performance ' || ordinality::text,
            TRUE
     FROM unnest($1::uuid[]) WITH ORDINALITY AS seeded(id, ordinality)`,
    [currencyIds],
  );
  await pool.query(
    `INSERT INTO items(id, slug)
     SELECT id, 'f8-3-perf-item-' || lpad(ordinality::text, 2, '0')
     FROM unnest($1::uuid[]) WITH ORDINALITY AS seeded(id, ordinality)`,
    [itemIds],
  );

  await pool.query(
    `INSERT INTO wallet_balances(player_id, currency_id, amount)
     SELECT player_id, currency_id, 85
     FROM unnest($1::uuid[]) AS player(player_id)
     CROSS JOIN unnest($2::uuid[]) AS currency(currency_id)`,
    [playerIds, currencyIds],
  );
  await pool.query(
    `INSERT INTO wallet_ledger(
       id, player_id, currency_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id, created_at
     )
     SELECT gen_random_uuid(),
            player_id,
            currency_id,
            CASE event_no WHEN 1 THEN 100 WHEN 2 THEN -20 WHEN 3 THEN 10 ELSE -5 END,
            'F8_3_PERFORMANCE',
            'event-' || event_no::text,
            'aggregate performance proof',
            'SYSTEM',
            'f8.3-performance',
            player_id::text || ':' || currency_id::text || ':' || event_no::text,
            gen_random_uuid(),
            now() - (event_no::text || ' days')::interval
     FROM unnest($1::uuid[]) AS player(player_id)
     CROSS JOIN unnest($2::uuid[]) AS currency(currency_id)
     CROSS JOIN generate_series(1, 4) AS event(event_no)`,
    [playerIds, currencyIds],
  );

  await pool.query(
    `INSERT INTO inventory_balances(player_id, item_id, quantity)
     SELECT player_id, item_id, 9
     FROM unnest($1::uuid[]) AS player(player_id)
     CROSS JOIN unnest($2::uuid[]) AS item(item_id)`,
    [playerIds, itemIds],
  );
  await pool.query(
    `INSERT INTO inventory_ledger(
       id, player_id, item_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id, created_at
     )
     SELECT gen_random_uuid(),
            player_id,
            item_id,
            CASE event_no WHEN 1 THEN 10 WHEN 2 THEN -3 ELSE 2 END,
            'F8_3_PERFORMANCE',
            'event-' || event_no::text,
            'aggregate performance proof',
            'SYSTEM',
            'f8.3-performance',
            player_id::text || ':' || item_id::text || ':' || event_no::text,
            gen_random_uuid(),
            now() - (event_no::text || ' days')::interval
     FROM unnest($1::uuid[]) AS player(player_id)
     CROSS JOIN unnest($2::uuid[]) AS item(item_id)
     CROSS JOIN generate_series(1, 3) AS event(event_no)`,
    [playerIds, itemIds],
  );

  const samplePlayerId = playerIds[0];
  const sampleItemId = itemIds[0];
  assert(samplePlayerId !== undefined && sampleItemId !== undefined, "Missing anomaly fixture key");
  await pool.query(
    `UPDATE inventory_balances
     SET quantity = quantity + 1,
         revision = revision + 1,
         updated_at = now()
     WHERE player_id = $1
       AND item_id = $2`,
    [samplePlayerId, sampleItemId],
  );

  await Promise.all([
    pool.query("ANALYZE wallet_balances"),
    pool.query("ANALYZE wallet_ledger"),
    pool.query("ANALYZE inventory_balances"),
    pool.query("ANALYZE inventory_ledger"),
    pool.query("ANALYZE currency_definitions"),
  ]);
}

async function proveIndexes(pool: Pool): Promise<void> {
  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN (
         'idx_wallet_ledger_created_currency',
         'idx_inventory_ledger_created'
       )`,
  );
  const names = new Set(indexes.rows.map((row) => row.indexname));
  assert(
    names.has("idx_wallet_ledger_created_currency"),
    "F8.3 wallet temporal aggregate index is missing",
  );
  assert(
    names.has("idx_inventory_ledger_created"),
    "F8.3 inventory temporal aggregate index is missing",
  );
}

async function proveExplainAnalyze(pool: Pool): Promise<void> {
  const asOf = new Date(Date.now() + 1_000);
  const timings: Record<string, number> = {};

  const walletFlow = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT currency_id,
            sum(delta) FILTER (WHERE delta > 0) AS inflow,
            sum(-delta) FILTER (WHERE delta < 0) AS outflow,
            sum(delta) AS net_flow
     FROM wallet_ledger
     WHERE created_at >= $1::timestamptz - interval '30 days'
       AND created_at < $1::timestamptz
     GROUP BY currency_id`,
    [asOf],
  );
  timings.walletFlow = executionTimeMs(walletFlow.rows[0]?.["QUERY PLAN"]);

  const inventoryFlow = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT sum(delta) FILTER (WHERE delta > 0) AS inflow_units,
            sum(-delta) FILTER (WHERE delta < 0) AS outflow_units,
            sum(delta) AS net_flow_units
     FROM inventory_ledger
     WHERE created_at >= $1::timestamptz - interval '30 days'
       AND created_at < $1::timestamptz`,
    [asOf],
  );
  timings.inventoryFlow = executionTimeMs(inventoryFlow.rows[0]?.["QUERY PLAN"]);

  const walletReconciliation = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     WITH reconstructed AS (
       SELECT player_id, currency_id, sum(delta) AS amount
       FROM wallet_ledger
       WHERE created_at < $1::timestamptz
       GROUP BY player_id, currency_id
     )
     SELECT count(*)
     FROM wallet_balances balance
     FULL OUTER JOIN reconstructed
       ON reconstructed.player_id = balance.player_id
      AND reconstructed.currency_id = balance.currency_id
     WHERE COALESCE(reconstructed.amount, 0) <> COALESCE(balance.amount, 0)`,
    [asOf],
  );
  timings.walletReconciliation = executionTimeMs(walletReconciliation.rows[0]?.["QUERY PLAN"]);

  const inventoryReconciliation = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     WITH reconstructed AS (
       SELECT player_id, item_id, sum(delta) AS quantity
       FROM inventory_ledger
       WHERE created_at < $1::timestamptz
       GROUP BY player_id, item_id
     )
     SELECT count(*)
     FROM inventory_balances balance
     FULL OUTER JOIN reconstructed
       ON reconstructed.player_id = balance.player_id
      AND reconstructed.item_id = balance.item_id
     WHERE COALESCE(reconstructed.quantity, 0) <> COALESCE(balance.quantity, 0)`,
    [asOf],
  );
  timings.inventoryReconciliation = executionTimeMs(
    inventoryReconciliation.rows[0]?.["QUERY PLAN"],
  );

  for (const [name, elapsedMs] of Object.entries(timings)) {
    assert(
      elapsedMs <= EXPLAIN_BUDGET_MS,
      `F8.3 ${name} EXPLAIN exceeded budget: ${elapsedMs.toFixed(2)}ms > ${EXPLAIN_BUDGET_MS}ms`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ phase: "F8.3-explain", executionMs: timings, budgetMs: EXPLAIN_BUDGET_MS })}\n`,
  );
}

function assertAggregate(
  result: Awaited<ReturnType<PostgresEconomyAnalyticsRepository["readAggregate"]>>,
): void {
  assert(result.currencies.length === CURRENCY_COUNT, `Expected ${CURRENCY_COUNT} currencies`);
  assert(!result.currenciesTruncated, "Performance fixture unexpectedly truncated currencies");
  for (const currency of result.currencies) {
    assert(currency.inflow === "165000", `Unexpected currency inflow: ${currency.inflow}`);
    assert(currency.outflow === "37500", `Unexpected currency outflow: ${currency.outflow}`);
    assert(currency.netFlow === "127500", `Unexpected currency net flow: ${currency.netFlow}`);
    assert(
      currency.totalBalance === "127500",
      `Unexpected currency balance: ${currency.totalBalance}`,
    );
  }
  assert(result.inventory.inflowUnits === "216000", "Unexpected inventory inflow volume");
  assert(result.inventory.outflowUnits === "54000", "Unexpected inventory outflow volume");
  assert(result.inventory.netFlowUnits === "162000", "Unexpected inventory net volume");
  assert(result.inventory.totalUnitsHeld === "162001", "Unexpected inventory held volume");
  assert(
    result.walletProjectionMismatches === "0",
    "Wallet reconciliation produced a false anomaly",
  );
  assert(
    result.inventoryProjectionMismatches === "1",
    "Inventory reconciliation missed the seeded drift",
  );
}

async function proveAggregateBudget(pool: Pool): Promise<void> {
  const repository = new PostgresEconomyAnalyticsRepository(pool);
  const asOf = new Date(Date.now() + 1_000);

  assertAggregate(await repository.readAggregate("production", asOf));

  const timings: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const startedAt = performance.now();
    const result = await repository.readAggregate("production", asOf);
    const elapsedMs = performance.now() - startedAt;
    assertAggregate(result);
    timings.push(elapsedMs);
  }
  const sorted = [...timings].sort((left, right) => left - right);
  const p95Ms = sorted[sorted.length - 1];
  assert(p95Ms !== undefined, "Missing sequential F8.3 timing");
  assert(
    p95Ms <= SEQUENTIAL_BUDGET_MS,
    `F8.3 aggregate exceeded sequential budget: ${p95Ms.toFixed(2)}ms > ${SEQUENTIAL_BUDGET_MS}ms`,
  );

  const concurrentStartedAt = performance.now();
  const concurrent = await Promise.allSettled(
    Array.from({ length: 4 }, () => repository.readAggregate("production", asOf)),
  );
  const concurrentElapsedMs = performance.now() - concurrentStartedAt;
  const failures = concurrent.filter((result) => result.status === "rejected");
  assert(failures.length === 0, `F8.3 concurrent aggregate had ${failures.length} failures`);
  for (const result of concurrent) {
    if (result.status === "fulfilled") assertAggregate(result.value);
  }
  assert(
    concurrentElapsedMs <= CONCURRENT_BUDGET_MS,
    `F8.3 concurrent aggregate exceeded budget: ${concurrentElapsedMs.toFixed(2)}ms > ${CONCURRENT_BUDGET_MS}ms`,
  );
  assert(pool.waitingCount === 0, `F8.3 performance proof left ${pool.waitingCount} DB waiters`);
  assert(pool.totalCount <= 8, `F8.3 performance proof exceeded pool max: ${pool.totalCount}`);

  process.stdout.write(
    `${JSON.stringify({
      phase: "F8.3",
      players: PLAYER_COUNT,
      currencies: CURRENCY_COUNT,
      items: ITEM_COUNT,
      walletLedgerRows: PLAYER_COUNT * CURRENCY_COUNT * 4,
      inventoryLedgerRows: PLAYER_COUNT * ITEM_COUNT * 3,
      sequentialMs: timings.map((value) => Number(value.toFixed(2))),
      p95Ms: Number(p95Ms.toFixed(2)),
      sequentialBudgetMs: SEQUENTIAL_BUDGET_MS,
      concurrentReads: concurrent.length,
      concurrentElapsedMs: Number(concurrentElapsedMs.toFixed(2)),
      concurrentBudgetMs: CONCURRENT_BUDGET_MS,
    })}\n`,
  );
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
  try {
    await seedEconomyFixture(pool);
    await proveIndexes(pool);
    await proveExplainAnalyze(pool);
    await proveAggregateBudget(pool);
    process.stdout.write(
      "F8.3 economy analytics performance proof passed: bounded aggregate correctness, EXPLAIN ANALYZE, temporal indexes, sequential latency, concurrent latency and pool drain are within budget.\n",
    );
  } finally {
    await pool.end();
  }
}

await main();
