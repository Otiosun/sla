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

describe.sequential("PostgresEconomyAnalyticsRepository privacy threshold", () => {
  const dbName = `pokemon_economy_analytics_privacy_${process.pid}_${Date.now()}`;
  const asOf = new Date("2026-09-02T12:00:00.000Z");
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "economy-analytics-privacy-proof" });
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

  it("does not let zero balances pad the k-min for a single recent transactor", async () => {
    const players = Array.from({ length: 5 }, () => randomUUID());
    for (const id of players) {
      await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [id]);
    }

    const currencyId = randomUUID();
    await pool.query(
      "INSERT INTO currency_definitions(id, slug, display_name, allows_negative) VALUES ($1, 'f8-3-zero-padding', 'Zero Padding', FALSE)",
      [currencyId],
    );

    for (const playerId of players.slice(1)) {
      await pool.query(
        "INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 0)",
        [playerId, currencyId],
      );
    }

    await pool.query(
      `INSERT INTO wallet_ledger(
        id, player_id, currency_id, delta, source_type, source_id, reason, actor_type,
        idempotency_scope, idempotency_key, correlation_id, balance_after, created_at
      ) VALUES ($1,$2,$3,100,'F8_3_PRIVACY_TEST','single-actor','privacy threshold proof','SYSTEM','f8.3-privacy','single-actor',$4,100,$5)`,
      [randomUUID(), players[0], currencyId, randomUUID(), new Date("2026-09-01T00:00:00.000Z")],
    );

    const result = await new PostgresEconomyAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );

    expect(result.currencies.map((currency) => currency.slug)).not.toContain("f8-3-zero-padding");
  });
});
