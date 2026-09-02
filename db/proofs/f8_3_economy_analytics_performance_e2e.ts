import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the F8.3 economy analytics performance proof");
}

const AS_OF = new Date("2026-09-02T12:00:00.000Z");
const TOTAL_ROWS_PER_LEDGER = 50_100;
const RECENT_ROWS_PER_LEDGER = 100;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function planText(plan: unknown): string {
  return JSON.stringify(plan);
}

async function seedEconomyHistory(pool: Pool): Promise<void> {
  const playerId = randomUUID();
  const currencyId = randomUUID();
  const itemId = randomUUID();

  await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, 'f8-3-performance-currency', 'F8.3 Performance Currency', FALSE)`,
    [currencyId],
  );
  await pool.query("INSERT INTO items(id, slug) VALUES ($1, 'f8-3-performance-item')", [itemId]);

  await pool.query(
    `INSERT INTO wallet_ledger(
       id, player_id, currency_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id, created_at
     )
     SELECT
       md5('f8.3-wallet-id-' || series)::uuid,
       $1::uuid,
       $2::uuid,
       1,
       'F8_3_PERFORMANCE',
       series::text,
       'F8.3 temporal index proof',
       'SYSTEM',
       'f8.3-performance-wallet',
       series::text,
       md5('f8.3-wallet-correlation-' || series)::uuid,
       CASE
         WHEN series <= $4::integer
           THEN $3::timestamptz - interval '1 day' - series * interval '1 second'
         ELSE $3::timestamptz - interval '90 days' - series * interval '1 second'
       END
     FROM generate_series(1, $5::integer) AS generated(series)`,
    [playerId, currencyId, AS_OF, RECENT_ROWS_PER_LEDGER, TOTAL_ROWS_PER_LEDGER],
  );

  await pool.query(
    `INSERT INTO inventory_ledger(
       id, player_id, item_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id, created_at
     )
     SELECT
       md5('f8.3-inventory-id-' || series)::uuid,
       $1::uuid,
       $2::uuid,
       1,
       'F8_3_PERFORMANCE',
       series::text,
       'F8.3 temporal index proof',
       'SYSTEM',
       'f8.3-performance-inventory',
       series::text,
       md5('f8.3-inventory-correlation-' || series)::uuid,
       CASE
         WHEN series <= $4::integer
           THEN $3::timestamptz - interval '1 day' - series * interval '1 second'
         ELSE $3::timestamptz - interval '90 days' - series * interval '1 second'
       END
     FROM generate_series(1, $5::integer) AS generated(series)`,
    [playerId, itemId, AS_OF, RECENT_ROWS_PER_LEDGER, TOTAL_ROWS_PER_LEDGER],
  );

  await pool.query("ANALYZE wallet_ledger");
  await pool.query("ANALYZE inventory_ledger");
}

async function proveWalletTemporalPlan(pool: Pool): Promise<void> {
  const recent = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM wallet_ledger
     WHERE created_at >= $1::timestamptz - interval '30 days'
       AND created_at < $1::timestamptz`,
    [AS_OF],
  );
  assert(
    recent.rows[0]?.count === RECENT_ROWS_PER_LEDGER.toString(),
    `Wallet fixture selectivity drifted: expected ${RECENT_ROWS_PER_LEDGER}, got ${recent.rows[0]?.count}`,
  );

  const explain = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT currency_id,
            COALESCE(sum(delta) FILTER (WHERE delta > 0), 0) AS inflow,
            COALESCE(sum(-delta) FILTER (WHERE delta < 0), 0) AS outflow,
            COALESCE(sum(delta), 0) AS net_flow,
            count(DISTINCT player_id) AS participant_count
     FROM wallet_ledger
     WHERE created_at >= $1::timestamptz - interval '30 days'
       AND created_at < $1::timestamptz
     GROUP BY currency_id`,
    [AS_OF],
  );
  const text = planText(explain.rows[0]?.["QUERY PLAN"]);
  assert(
    text.includes("idx_wallet_ledger_created_currency"),
    `F8.3 wallet 30d aggregate did not use its temporal index: ${text}`,
  );
  assert(text.includes("Actual Total Time"), "F8.3 wallet EXPLAIN ANALYZE did not execute");
}

async function proveInventoryTemporalPlan(pool: Pool): Promise<void> {
  const recent = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM inventory_ledger
     WHERE created_at >= $1::timestamptz - interval '30 days'
       AND created_at < $1::timestamptz`,
    [AS_OF],
  );
  assert(
    recent.rows[0]?.count === RECENT_ROWS_PER_LEDGER.toString(),
    `Inventory fixture selectivity drifted: expected ${RECENT_ROWS_PER_LEDGER}, got ${recent.rows[0]?.count}`,
  );

  const explain = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT COALESCE(sum(delta) FILTER (WHERE delta > 0), 0) AS inflow_units,
            COALESCE(sum(-delta) FILTER (WHERE delta < 0), 0) AS outflow_units,
            COALESCE(sum(delta), 0) AS net_flow_units
     FROM inventory_ledger
     WHERE created_at >= $1::timestamptz - interval '30 days'
       AND created_at < $1::timestamptz`,
    [AS_OF],
  );
  const text = planText(explain.rows[0]?.["QUERY PLAN"]);
  assert(
    text.includes("idx_inventory_ledger_created"),
    `F8.3 inventory 30d aggregate did not use its temporal index: ${text}`,
  );
  assert(text.includes("Actual Total Time"), "F8.3 inventory EXPLAIN ANALYZE did not execute");
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000 });
  try {
    await seedEconomyHistory(pool);
    await proveWalletTemporalPlan(pool);
    await proveInventoryTemporalPlan(pool);
    process.stdout.write(
      `${JSON.stringify({ proof: "f8.3-economy-analytics-performance", rowsPerLedger: TOTAL_ROWS_PER_LEDGER, recentRowsPerLedger: RECENT_ROWS_PER_LEDGER, walletIndex: "idx_wallet_ledger_created_currency", inventoryIndex: "idx_inventory_ledger_created" })}\n`,
    );
  } finally {
    await pool.end();
  }
}

await main();
