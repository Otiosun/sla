import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminAccessSessionUseRequest } from "../../src/adapters/admin-api/access-session-guard.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { PostgresAdminAccessSessionRepository } from "../../src/platform/admin/postgres-admin-access-session-repository.js";
import { reconcileCanonicalAdminRegistry } from "../../src/platform/admin/postgres-admin-registry-seed.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresAdminSessionRevocationPort } from "../../src/platform/admin/postgres-admin-session-revocation-port.js";
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

function sessionRequest(input: {
  principalId: string;
  environment: "staging" | "production";
  fingerprint: string;
  issuedAt: Date;
  observedAt: Date;
  expiresAt: Date;
}): AdminAccessSessionUseRequest {
  return {
    principalId: input.principalId,
    environment: input.environment,
    tokenFingerprint: input.fingerprint,
    accessIssuedAt: input.issuedAt,
    accessNotBefore: input.issuedAt,
    accessExpiresAt: input.expiresAt,
    observedAt: input.observedAt,
    idleExpiresAt: new Date(input.observedAt.getTime() + 15 * 60 * 1_000),
  };
}

describe.sequential("admin session environment isolation", () => {
  const dbName = `pokemon_admin_session_env_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "admin-session-environment-isolation-proof" });
    const client = await pool.connect();
    try {
      await reconcileCanonicalAdminRegistry(client);
    } finally {
      client.release();
    }
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

  it("revokes staging without changing production sessions or production cutoff", async () => {
    const proposerId = randomUUID();
    const approverId = randomUUID();
    const targetId = randomUUID();
    const ownerRole = await pool.query<{ id: string }>(
      "SELECT id FROM admin_roles WHERE slug = 'OWNER_SECURITY_ADMIN'",
    );
    const ownerRoleId = ownerRole.rows[0]?.id;
    if (ownerRoleId === undefined) throw new Error("OWNER_SECURITY_ADMIN role was not seeded");

    await pool.query(
      `INSERT INTO admin_principals(id, identity_ref, status)
       VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE'), ($5, $6, 'ACTIVE')`,
      [
        proposerId,
        `proof:env:proposer:${proposerId}`,
        approverId,
        `proof:env:approver:${approverId}`,
        targetId,
        `proof:env:target:${targetId}`,
      ],
    );
    await pool.query(
      `INSERT INTO admin_principal_roles(principal_id, role_id)
       VALUES ($1, $3), ($2, $3)`,
      [proposerId, approverId, ownerRoleId],
    );
    for (const principalId of [proposerId, approverId]) {
      await pool.query(
        `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
         VALUES ($1, $2, 'GLOBAL', NULL)`,
        [randomUUID(), principalId],
      );
    }

    const sessions = new PostgresAdminAccessSessionRepository(pool);
    const baseIssuedAt = new Date("2026-08-31T17:00:00.000Z");
    const expiresAt = new Date("2026-08-31T23:00:00.000Z");
    await expect(
      sessions.useSession(
        sessionRequest({
          principalId: targetId,
          environment: "staging",
          fingerprint: "d".repeat(64),
          issuedAt: baseIssuedAt,
          observedAt: new Date("2026-08-31T17:30:00.000Z"),
          expiresAt,
        }),
      ),
    ).resolves.toBe("ACTIVE");
    await expect(
      sessions.useSession(
        sessionRequest({
          principalId: targetId,
          environment: "production",
          fingerprint: "e".repeat(64),
          issuedAt: baseIssuedAt,
          observedAt: new Date("2026-08-31T17:30:00.000Z"),
          expiresAt,
        }),
      ),
    ).resolves.toBe("ACTIVE");

    const repository = new PostgresAdminRepository(pool);
    const revocationPort = new PostgresAdminSessionRevocationPort(pool);
    const admin = new AdminService(
      createPhase12AdminOperationRegistry(repository, revocationPort),
      repository,
    );
    const prepared = await admin.prepareMutation({
      principalId: proposerId,
      operationType: "admin.session.revoke_all",
      input: { principalId: targetId, environment: "staging" },
      reason: "staging security incident",
      idempotencyKey: `admin-session-environment-${randomUUID()}`,
      correlationId: randomUUID(),
    });

    const simulated = await admin.simulate(prepared.operation.id, proposerId);
    expect(simulated.result).toMatchObject({
      simulation: {
        summary: {
          environment: "staging",
          activeSessions: 1,
        },
      },
    });
    await admin.confirm(prepared.operation.id, proposerId);
    await admin.approve(prepared.operation.id, approverId, "independent staging approval");
    const applied = await admin.apply(prepared.operation.id, proposerId);
    expect(applied.result).toMatchObject({
      applied: true,
      environment: "staging",
      revokedSessions: 1,
    });

    const persisted = await pool.query<{
      environment: string;
      status: string;
    }>(
      `SELECT environment, status
       FROM admin_access_sessions
       WHERE principal_id = $1
       ORDER BY environment`,
      [targetId],
    );
    expect(persisted.rows).toEqual([
      { environment: "production", status: "ACTIVE" },
      { environment: "staging", status: "REVOKED" },
    ]);

    const cutoffs = await pool.query<{
      environment: string;
      revoked_before: Date;
    }>(
      `SELECT environment, revoked_before
       FROM admin_access_session_revocation_cutoffs
       WHERE principal_id = $1
       ORDER BY environment`,
      [targetId],
    );
    expect(cutoffs.rows).toHaveLength(1);
    expect(cutoffs.rows[0]?.environment).toBe("staging");
    const stagingCutoff = cutoffs.rows[0]?.revoked_before;
    if (stagingCutoff === undefined) throw new Error("staging cutoff was not persisted");

    await expect(
      sessions.useSession(
        sessionRequest({
          principalId: targetId,
          environment: "staging",
          fingerprint: "f".repeat(64),
          issuedAt: new Date(stagingCutoff.getTime() - 1_000),
          observedAt: new Date(stagingCutoff.getTime() + 1_000),
          expiresAt: new Date(stagingCutoff.getTime() + 60 * 60 * 1_000),
        }),
      ),
    ).resolves.toBe("DENIED");

    await expect(
      sessions.useSession(
        sessionRequest({
          principalId: targetId,
          environment: "production",
          fingerprint: "1".repeat(64),
          issuedAt: new Date(stagingCutoff.getTime() - 1_000),
          observedAt: new Date(stagingCutoff.getTime() + 1_000),
          expiresAt: new Date(stagingCutoff.getTime() + 60 * 60 * 1_000),
        }),
      ),
    ).resolves.toBe("ACTIVE");
  });
});
