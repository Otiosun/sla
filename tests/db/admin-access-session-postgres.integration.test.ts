import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminAccessSessionUseRequest } from "../../src/adapters/admin-api/access-session-guard.js";
import { PostgresAdminAccessSessionRepository } from "../../src/platform/admin/postgres-admin-access-session-repository.js";
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
const OTHER_PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT = "a".repeat(64);

function sessionUse(
  overrides: Partial<AdminAccessSessionUseRequest> = {},
): AdminAccessSessionUseRequest {
  return {
    principalId: PRINCIPAL_ID,
    environment: "staging",
    tokenFingerprint: FINGERPRINT,
    accessIssuedAt: new Date("2026-08-31T15:00:00.000Z"),
    accessNotBefore: new Date("2026-08-31T15:00:00.000Z"),
    accessExpiresAt: new Date("2026-08-31T18:00:00.000Z"),
    observedAt: new Date("2026-08-31T16:00:00.000Z"),
    idleExpiresAt: new Date("2026-08-31T16:30:00.000Z"),
    ...overrides,
  };
}

describe.sequential("PostgresAdminAccessSessionRepository", () => {
  const dbName = `pokemon_admin_access_session_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let firstPool: Pool;
  let secondPool: Pool;
  let first: PostgresAdminAccessSessionRepository;
  let second: PostgresAdminAccessSessionRepository;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    firstPool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    secondPool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(firstPool, { appliedBy: "admin-access-session-proof" });
    await firstPool.query(
      `INSERT INTO admin_principals (id, identity_ref, status)
       VALUES
         ($1, 'cloudflare-access:test:principal', 'ACTIVE'),
         ($2, 'cloudflare-access:test:other', 'ACTIVE')`,
      [PRINCIPAL_ID, OTHER_PRINCIPAL_ID],
    );
    first = new PostgresAdminAccessSessionRepository(firstPool);
    second = new PostgresAdminAccessSessionRepository(secondPool);
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

  it("admits once and refreshes activity without storing the raw Access token", async () => {
    await expect(first.useSession(sessionUse())).resolves.toBe("ACTIVE");
    await expect(
      second.useSession(
        sessionUse({
          observedAt: new Date("2026-08-31T16:10:00.000Z"),
          idleExpiresAt: new Date("2026-08-31T16:40:00.000Z"),
        }),
      ),
    ).resolves.toBe("ACTIVE");

    const stored = await firstPool.query<{
      token_fingerprint: string;
      status: string;
      last_seen_at: Date;
      idle_expires_at: Date;
    }>(
      `SELECT token_fingerprint, status, last_seen_at, idle_expires_at
       FROM admin_access_sessions
       WHERE token_fingerprint = $1`,
      [FINGERPRINT],
    );

    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      token_fingerprint: FINGERPRINT,
      status: "ACTIVE",
      last_seen_at: new Date("2026-08-31T16:10:00.000Z"),
      idle_expires_at: new Date("2026-08-31T16:40:00.000Z"),
    });

    const rawTokenColumns = await firstPool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'admin_access_sessions'
         AND column_name ILIKE '%token%'
         AND column_name <> 'token_fingerprint'`,
    );
    expect(rawTokenColumns.rows).toEqual([]);
  });

  it("keeps a revoked fingerprint as a tombstone and rejects concurrent resurrection", async () => {
    await expect(
      first.revokeSession({
        tokenFingerprint: FINGERPRINT,
        revokedAt: new Date("2026-08-31T16:15:00.000Z"),
        revokedByPrincipalId: PRINCIPAL_ID,
        reason: "SELF_LOGOUT",
      }),
    ).resolves.toBe(true);

    const replay = sessionUse({
      observedAt: new Date("2026-08-31T16:16:00.000Z"),
      idleExpiresAt: new Date("2026-08-31T16:46:00.000Z"),
    });
    await expect(Promise.all([first.useSession(replay), second.useSession(replay)])).resolves.toEqual([
      "DENIED",
      "DENIED",
    ]);

    const stored = await firstPool.query<{
      status: string;
      revoked_at: Date;
      revocation_reason: string;
      last_seen_at: Date;
    }>(
      `SELECT status, revoked_at, revocation_reason, last_seen_at
       FROM admin_access_sessions
       WHERE token_fingerprint = $1`,
      [FINGERPRINT],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "REVOKED",
      revoked_at: new Date("2026-08-31T16:15:00.000Z"),
      revocation_reason: "SELF_LOGOUT",
      last_seen_at: new Date("2026-08-31T16:10:00.000Z"),
    });
  });

  it("denies a fingerprint after idle expiry and does not refresh it", async () => {
    const fingerprint = "b".repeat(64);
    await expect(
      first.useSession(sessionUse({ tokenFingerprint: fingerprint })),
    ).resolves.toBe("ACTIVE");

    await expect(
      second.useSession(
        sessionUse({
          tokenFingerprint: fingerprint,
          observedAt: new Date("2026-08-31T16:30:00.000Z"),
          idleExpiresAt: new Date("2026-08-31T17:00:00.000Z"),
        }),
      ),
    ).resolves.toBe("DENIED");

    const stored = await firstPool.query<{ last_seen_at: Date; idle_expires_at: Date }>(
      `SELECT last_seen_at, idle_expires_at
       FROM admin_access_sessions
       WHERE token_fingerprint = $1`,
      [fingerprint],
    );
    expect(stored.rows[0]).toMatchObject({
      last_seen_at: new Date("2026-08-31T16:00:00.000Z"),
      idle_expires_at: new Date("2026-08-31T16:30:00.000Z"),
    });
  });

  it("denies reuse of one fingerprint under a different principal or environment", async () => {
    const fingerprint = "c".repeat(64);
    await expect(
      first.useSession(sessionUse({ tokenFingerprint: fingerprint })),
    ).resolves.toBe("ACTIVE");

    await expect(
      second.useSession(
        sessionUse({ tokenFingerprint: fingerprint, principalId: OTHER_PRINCIPAL_ID }),
      ),
    ).resolves.toBe("DENIED");
    await expect(
      second.useSession(sessionUse({ tokenFingerprint: fingerprint, environment: "production" })),
    ).resolves.toBe("DENIED");
  });
});
