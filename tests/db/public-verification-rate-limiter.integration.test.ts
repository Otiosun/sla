import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPublicVerificationRateLimiter } from "../../src/platform/verification/postgres-public-verification-rate-limiter.js";

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

const PUBLIC_ID = "tcv_7Qm2Yp9Kx4Nw8Vr6Hs3Df1Za";
const OTHER_PUBLIC_ID = "tcv_Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8";
const RATE_LIMIT_PEPPER = new Uint8Array(32).fill(17);

describe.sequential("PostgresPublicVerificationRateLimiter", () => {
  const dbName = `pokemon_public_verification_limit_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  async function waitForDatabaseSessionsToClose(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_stat_activity
         WHERE datname = $1
           AND pid <> pg_backend_pid()`,
        [dbName],
      );
      if (result.rows[0]?.count === "0") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Public verification limiter database sessions did not close cleanly");
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 12 });
    await runMigrations(pool, { appliedBy: "public-verification-rate-limit-proof" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await waitForDatabaseSessionsToClose();
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("enforces a durable target-and-peer bucket without persisting raw identifiers", async () => {
    const limiter = new PostgresPublicVerificationRateLimiter(pool, RATE_LIMIT_PEPPER, {
      limit: 2,
      peerLimit: 10,
      windowSeconds: 60,
    });
    const request = { publicId: PUBLIC_ID, remoteAddress: "203.0.113.42" };

    await expect(limiter.consume(request)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume(request)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume(request)).resolves.toMatchObject({ allowed: false });

    const persisted = await pool.query<{
      peer_hash: string;
      target_hash: string;
      request_count: number;
    }>(
      `SELECT peer_hash, target_hash, request_count
       FROM public_verification_rate_limit_buckets`,
    );
    expect(persisted.rows).toHaveLength(2);
    for (const row of persisted.rows) {
      expect(row.peer_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.target_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.request_count).toBe(3);
    }
    expect(JSON.stringify(persisted.rows)).not.toContain("203.0.113.42");
    expect(JSON.stringify(persisted.rows)).not.toContain(PUBLIC_ID);
  });

  it("isolates targets and peers and preserves budget across repository restart", async () => {
    const first = new PostgresPublicVerificationRateLimiter(pool, RATE_LIMIT_PEPPER, {
      limit: 1,
      peerLimit: 10,
      windowSeconds: 60,
    });
    const base = { publicId: OTHER_PUBLIC_ID, remoteAddress: "198.51.100.10" };

    await expect(first.consume(base)).resolves.toMatchObject({ allowed: true });
    const restarted = new PostgresPublicVerificationRateLimiter(pool, RATE_LIMIT_PEPPER, {
      limit: 1,
      peerLimit: 10,
      windowSeconds: 60,
    });
    await expect(restarted.consume(base)).resolves.toMatchObject({ allowed: false });
    await expect(
      restarted.consume({ ...base, remoteAddress: "198.51.100.11" }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      restarted.consume({ publicId: PUBLIC_ID, remoteAddress: base.remoteAddress }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("enforces a peer-wide budget across target rotation", async () => {
    const limiter = new PostgresPublicVerificationRateLimiter(pool, RATE_LIMIT_PEPPER, {
      limit: 10,
      peerLimit: 3,
      windowSeconds: 60,
    });
    const remoteAddress = "192.0.2.90";
    const targets = [
      "tcv_111111111111111111111111",
      "tcv_222222222222222222222222",
      "tcv_333333333333333333333333",
      "tcv_444444444444444444444444",
    ] as const;

    await expect(
      limiter.consume({ publicId: targets[0], remoteAddress }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ publicId: targets[1], remoteAddress }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ publicId: targets[2], remoteAddress }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ publicId: targets[3], remoteAddress }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      limiter.consume({ publicId: targets[3], remoteAddress: "192.0.2.91" }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("does not overshoot the configured budget under concurrency", async () => {
    const limiter = new PostgresPublicVerificationRateLimiter(pool, RATE_LIMIT_PEPPER, {
      limit: 3,
      peerLimit: 3,
      windowSeconds: 60,
    });
    const request = {
      publicId: "tcv_Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2",
      remoteAddress: "192.0.2.77",
    };

    const decisions = await Promise.all(Array.from({ length: 20 }, () => limiter.consume(request)));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(17);
  });

  it("rejects weak peppers and invalid policies", () => {
    expect(
      () =>
        new PostgresPublicVerificationRateLimiter(pool, new Uint8Array(8), {
          limit: 2,
          peerLimit: 10,
          windowSeconds: 60,
        }),
    ).toThrow();
    expect(
      () =>
        new PostgresPublicVerificationRateLimiter(pool, RATE_LIMIT_PEPPER, {
          limit: 0,
          peerLimit: 10,
          windowSeconds: 60,
        }),
    ).toThrow();
    expect(
      () =>
        new PostgresPublicVerificationRateLimiter(pool, RATE_LIMIT_PEPPER, {
          limit: 2,
          peerLimit: 0,
          windowSeconds: 60,
        }),
    ).toThrow();
  });
});
