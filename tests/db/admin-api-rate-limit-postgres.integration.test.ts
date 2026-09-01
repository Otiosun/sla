import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdminApiRateLimiter } from "../../src/platform/admin/postgres-admin-api-rate-limiter.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";

describe.sequential("PostgresAdminApiRateLimiter", () => {
  const dbName = `pokemon_admin_rate_limit_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let firstPool: Pool;
  let secondPool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    firstPool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    secondPool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(firstPool, { appliedBy: "admin-rate-limit-proof" });
    await firstPool.query(
      `INSERT INTO admin_principals (id, identity_ref, status)
       VALUES ($1, 'cloudflare-access:test:principal', 'ACTIVE')`,
      [PRINCIPAL_ID],
    );
  }, 30_000);

  afterAll(async () => {
    await firstPool.end();
    await secondPool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("shares one atomic player.search budget across independent API instances", async () => {
    const policy = {
      "player.search": { limit: 3, windowSeconds: 60 },
    } as const;
    const first = new PostgresAdminApiRateLimiter(firstPool, policy);
    const second = new PostgresAdminApiRateLimiter(secondPool, policy);

    const attempts = await Promise.all([
      first.consume({ principalId: PRINCIPAL_ID, operation: "player.search" }),
      second.consume({ principalId: PRINCIPAL_ID, operation: "player.search" }),
      first.consume({ principalId: PRINCIPAL_ID, operation: "player.search" }),
      second.consume({ principalId: PRINCIPAL_ID, operation: "player.search" }),
      first.consume({ principalId: PRINCIPAL_ID, operation: "player.search" }),
      second.consume({ principalId: PRINCIPAL_ID, operation: "player.search" }),
    ]);

    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(3);
    expect(attempts.filter((attempt) => !attempt.allowed)).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.retryAfterSeconds >= 1)).toBe(true);

    const bucket = await firstPool.query<{ request_count: number }>(
      `SELECT request_count
       FROM admin_api_rate_limit_buckets
       WHERE principal_id = $1 AND operation = 'player.search'`,
      [PRINCIPAL_ID],
    );
    expect(bucket.rows[0]?.request_count).toBe(6);
  });

  it("accepts the content.search operation used by Content Studio routes", async () => {
    const limiter = new PostgresAdminApiRateLimiter(firstPool, {
      "content.search": { limit: 2, windowSeconds: 60 },
    });

    const decision = await limiter.consume({
      principalId: PRINCIPAL_ID,
      operation: "content.search",
    });

    expect(decision.allowed).toBe(true);
    const bucket = await firstPool.query<{ request_count: number }>(
      `SELECT request_count
       FROM admin_api_rate_limit_buckets
       WHERE principal_id = $1 AND operation = 'content.search'`,
      [PRINCIPAL_ID],
    );
    expect(bucket.rows[0]?.request_count).toBe(1);
  });

  it("accepts the runtime.health.read operation used by the operational health route", async () => {
    const limiter = new PostgresAdminApiRateLimiter(firstPool, {
      "runtime.health.read": { limit: 2, windowSeconds: 60 },
    });

    const decision = await limiter.consume({
      principalId: PRINCIPAL_ID,
      operation: "runtime.health.read",
    });

    expect(decision.allowed).toBe(true);
    const bucket = await firstPool.query<{ request_count: number }>(
      `SELECT request_count
       FROM admin_api_rate_limit_buckets
       WHERE principal_id = $1 AND operation = 'runtime.health.read'`,
      [PRINCIPAL_ID],
    );
    expect(bucket.rows[0]?.request_count).toBe(1);
  });
});
