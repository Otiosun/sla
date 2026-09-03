import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresEconomyAnalyticsRepository } from "../../src/platform/admin/postgres-economy-analytics-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();
function dbUrl(name: string) {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("PostgresEconomyAnalyticsRepository", () => {
  const dbName = `pokemon_economy_analytics_${process.pid}_${Date.now()}`;
  const asOf = new Date("2026-09-02T12:00:00.000Z");
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "economy-analytics-proof" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("reconciles projection by commutative ledger deltas, respects currency policy, suppresses low-cardinality currencies, and excludes future rows from flow", async () => {
    const players = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ] as const;
    for (const id of players)
      await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [id]);
    const currency = randomUUID();
    const privateCurrency = randomUUID();
    const item = randomUUID();
    await pool.query(
      "INSERT INTO currency_definitions(id, slug, display_name, allows_negative) VALUES ($1, 'f8-3-visible', 'Visible', TRUE), ($2, 'f8-3-private', 'Private', FALSE)",
      [currency, privateCurrency],
    );
    await pool.query("INSERT INTO items(id, slug) VALUES ($1, 'f8-3-item')", [item]);

    const sameTimestamp = new Date("2026-08-20T00:00:00.000Z");
    for (const [index, playerId] of players.slice(0, 5).entries()) {
      const amount = index === 0 ? 80 : index === 4 ? -5 : 1;
      const delta = index === 0 ? 100 : index === 4 ? -5 : 1;
      await pool.query(
        "INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, $3)",
        [playerId, currency, amount],
      );
      await pool.query(
        `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
        VALUES ($1,$2,$3,$4,'F8_3_TEST',$5,'aggregate proof','SYSTEM','f8.3-test',$6,$7,$8,$9)`,
        [
          index === 0 ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : randomUUID(),
          playerId,
          currency,
          delta,
          `source-${index}`,
          `flow-${index}`,
          randomUUID(),
          delta,
          index === 0 ? sameTimestamp : new Date("2026-09-01T00:00:00.000Z"),
        ],
      );
    }
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
      VALUES ($1,$2,$3,-20,'F8_3_TEST','sink','aggregate proof','SYSTEM','f8.3-test','sink',$4,80,$5)`,
      ["00000000-0000-4000-8000-000000000001", players[0], currency, randomUUID(), sameTimestamp],
    );
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
      VALUES ($1,$2,$3,999,'F8_3_TEST','future','aggregate proof','SYSTEM','f8.3-test','future',$4,1079,$5)`,
      [randomUUID(), players[0], currency, randomUUID(), new Date("2026-09-03T00:00:00.000Z")],
    );
    await pool.query(
      "UPDATE wallet_balances SET amount = 1079 WHERE player_id = $1 AND currency_id = $2",
      [players[0], currency],
    );

    await pool.query(
      "INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 50)",
      [players[5], privateCurrency],
    );
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
      VALUES ($1,$2,$3,50,'F8_3_TEST','private','aggregate proof','SYSTEM','f8.3-test','private',$4,50,$5)`,
      [
        randomUUID(),
        players[5],
        privateCurrency,
        randomUUID(),
        new Date("2026-09-01T00:00:00.000Z"),
      ],
    );

    await pool.query(
      "INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES ($1,$2,8)",
      [players[0], item],
    );
    await pool.query(
      `INSERT INTO inventory_ledger(id, player_id, item_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
      VALUES ($1,$2,$3,10,'F8_3_TEST','inventory-source','aggregate proof','SYSTEM','f8.3-test','inventory-source',$4,10,$5),
             ($6,$2,$3,-3,'F8_3_TEST','inventory-sink','aggregate proof','SYSTEM','f8.3-test','inventory-sink',$7,7,$8)`,
      [
        randomUUID(),
        players[0],
        item,
        randomUUID(),
        new Date("2026-08-10T00:00:00.000Z"),
        randomUUID(),
        randomUUID(),
        new Date("2026-08-20T00:00:00.000Z"),
      ],
    );

    const result = await new PostgresEconomyAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );
    expect(result.currencies).toEqual([
      {
        slug: "f8-3-visible",
        displayName: "Visible",
        inflow: "103",
        outflow: "25",
        netFlow: "78",
        totalBalance: "1077",
      },
    ]);
    expect(result.currenciesTruncated).toBe(false);
    expect(result.inventory).toEqual({
      inflowUnits: "10",
      outflowUnits: "3",
      netFlowUnits: "7",
      totalUnitsHeld: "8",
    });
    expect(result.inventoryProjectionMismatches).toBe("1");
    expect(result.walletProjectionMismatches).toBe("0");
    expect(JSON.stringify(result)).not.toContain(players[0]);
  });

  it("does not report a committed post-asOf wallet mutation as projection drift", async () => {
    const playerId = randomUUID();
    const currencyId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO currency_definitions(id, slug, display_name, allows_negative) VALUES ($1, $2, 'Race proof', FALSE)",
      [currencyId, `race-${currencyId}`],
    );
    await pool.query(
      "INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 10)",
      [playerId, currencyId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
       VALUES ($1,$2,$3,10,'F8_3_RACE','post-asof','race proof','SYSTEM','f8.3-race','credit',$4,10,$5)`,
      [randomUUID(), playerId, currencyId, randomUUID(), new Date("2026-09-02T12:00:01.000Z")],
    );

    const result = await new PostgresEconomyAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );
    expect(result.walletProjectionMismatches).toBe("0");
  });
});
