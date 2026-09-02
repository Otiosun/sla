import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresEconomyAnalyticsRepository } from "../../src/platform/admin/postgres-economy-analytics-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

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

  it("separates sources/sinks, suppresses low-cardinality currencies, excludes future flow, and detects projection drift", async () => {
    const players = Array.from({ length: 6 }, () => randomUUID());
    for (const id of players) {
      await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [id]);
    }
    const currency = randomUUID();
    const privateCurrency = randomUUID();
    const item = randomUUID();
    await pool.query(
      "INSERT INTO currency_definitions(id, slug, display_name, allows_negative) VALUES ($1, 'f8-3-visible', 'Visible', TRUE), ($2, 'f8-3-private', 'Private', FALSE)",
      [currency, privateCurrency],
    );
    await pool.query("INSERT INTO items(id, slug) VALUES ($1, 'f8-3-item')", [item]);

    for (let index = 0; index < 5; index += 1) {
      const amount = index === 0 ? 80 : 1;
      await pool.query(
        "INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, $3)",
        [players[index], currency, amount],
      );
      await pool.query(
        `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
         VALUES ($1,$2,$3,$4,'F8_3_TEST',$5,'aggregate proof','SYSTEM','f8.3-test',$6,$7,$8,$9)`,
        [
          randomUUID(),
          players[index],
          currency,
          index === 0 ? 100 : 1,
          `source-${index}`,
          `credit-${index}`,
          randomUUID(),
          index === 0 ? 100 : 1,
          index === 0
            ? new Date("2026-08-03T12:00:00.000Z")
            : new Date("2026-09-01T00:00:00.000Z"),
        ],
      );
    }
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
       VALUES ($1,$2,$3,-20,'F8_3_TEST','sink','aggregate proof','SYSTEM','f8.3-test','sink',$4,80,$5)`,
      [randomUUID(), players[0], currency, randomUUID(), new Date("2026-08-20T00:00:00.000Z")],
    );
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
       VALUES ($1,$2,$3,999,'F8_3_TEST','future','aggregate proof','SYSTEM','f8.3-test','future',$4,1079,$5)`,
      [randomUUID(), players[0], currency, randomUUID(), new Date("2026-09-03T00:00:00.000Z")],
    );
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
       VALUES ($1,$2,$3,50,'F8_3_TEST','private','aggregate proof','SYSTEM','f8.3-test','private',$4,50,$5)`,
      [randomUUID(), players[5], privateCurrency, randomUUID(), new Date("2026-09-01T00:00:00.000Z")],
    );

    await pool.query(
      "INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES ($1,$2,7)",
      [players[0], item],
    );
    await pool.query(
      `INSERT INTO inventory_ledger(id, player_id, item_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
       VALUES ($1,$2,$3,10,'F8_3_TEST','inventory-source','aggregate proof','SYSTEM','f8.3-test','inventory-source',$4,10,$5),
              ($6,$2,$3,-3,'F8_3_TEST','inventory-sink','aggregate proof','SYSTEM','f8.3-test','inventory-sink',$7,6,$8)`,
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
        inflow: "104",
        outflow: "20",
        netFlow: "84",
        totalBalance: "84",
      },
    ]);
    expect(result.currenciesTruncated).toBe(false);
    expect(result.inventory).toEqual({
      inflowUnits: "10",
      outflowUnits: "3",
      netFlowUnits: "7",
      totalUnitsHeld: "7",
    });
    expect(result.inventoryProjectionMismatches).toBe(1);
    expect(result.walletProjectionMismatches).toBe(1);
    expect(JSON.stringify(result)).not.toContain(players[0]);
  });

  it("ignores future ledgers when reconciling the projection at the server-owned asOf", async () => {
    const playerId = randomUUID();
    const currencyId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO currency_definitions(id, slug, display_name, allows_negative) VALUES ($1, $2, $3, FALSE)",
      [currencyId, `future-${currencyId}`, "Future proof"],
    );
    await pool.query(
      "INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 80)",
      [playerId, currencyId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
       VALUES ($1,$2,$3,100,'F8_3_TEST','past-credit','future boundary','SYSTEM','f8.3-future','past-credit',$4,100,$5),
              ($6,$2,$3,-20,'F8_3_TEST','past-debit','future boundary','SYSTEM','f8.3-future','past-debit',$7,80,$8),
              ($9,$2,$3,999,'F8_3_TEST','future-credit','future boundary','SYSTEM','f8.3-future','future-credit',$10,1079,$11)`,
      [
        randomUUID(),
        playerId,
        currencyId,
        randomUUID(),
        new Date("2026-09-01T08:00:00.000Z"),
        randomUUID(),
        randomUUID(),
        new Date("2026-09-01T09:00:00.000Z"),
        randomUUID(),
        randomUUID(),
        new Date("2026-09-03T00:00:00.000Z"),
      ],
    );

    const result = await new PostgresEconomyAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );
    expect(result.walletProjectionMismatches).toBe(1);
  });

  it("does not infer final ledger state from UUID order when timestamps tie", async () => {
    const playerId = randomUUID();
    const currencyId = randomUUID();
    const timestamp = new Date("2026-09-01T10:00:00.000Z");
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO currency_definitions(id, slug, display_name, allows_negative) VALUES ($1, $2, $3, FALSE)",
      [currencyId, `tie-${currencyId}`, "Tie proof"],
    );
    await pool.query(
      "INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 80)",
      [playerId, currencyId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger(id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, idempotency_scope, idempotency_key, correlation_id, balance_after, created_at)
       VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff',$1,$2,100,'F8_3_TEST','credit','tie boundary','SYSTEM','f8.3-tie','credit',$3,100,$4),
              ('00000000-0000-4000-8000-000000000001',$1,$2,-20,'F8_3_TEST','debit','tie boundary','SYSTEM','f8.3-tie','debit',$5,80,$4)`,
      [playerId, currencyId, randomUUID(), timestamp, randomUUID()],
    );

    const result = await new PostgresEconomyAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );
    expect(result.walletProjectionMismatches).toBe(1);
  });
});
