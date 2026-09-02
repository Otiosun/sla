import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdminApiRateLimiter } from "../../src/platform/admin/postgres-admin-api-rate-limiter.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";

describe.sequential("F8.3 PostgreSQL economy analytics rate limit", () => {
  const dbName = `pokemon_economy_analytics_rate_limit_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "economy-analytics-rate-limit-proof" });
    await pool.query(
      `INSERT INTO admin_principals (id, identity_ref, status)
       VALUES ($1, 'cloudflare-access:test:economy-analytics', 'ACTIVE')`,
      [PRINCIPAL_ID],
    );
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

  it("persists the economy.analytics.read budget in the real PostgreSQL limiter", async () => {
    const limiter = new PostgresAdminApiRateLimiter(pool, {
      "economy.analytics.read": { limit: 2, windowSeconds: 60 },
    });

    const decision = await limiter.consume({
      principalId: PRINCIPAL_ID,
      operation: "economy.analytics.read",
    });

    expect(decision.allowed).toBe(true);
    const bucket = await pool.query<{ request_count: number }>(
      `SELECT request_count
       FROM admin_api_rate_limit_buckets
       WHERE principal_id = $1 AND operation = 'economy.analytics.read'`,
      [PRINCIPAL_ID],
    );
    expect(bucket.rows[0]?.request_count).toBe(1);
  });
});
