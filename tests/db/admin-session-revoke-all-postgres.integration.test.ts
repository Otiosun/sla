import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminAccessSessionUseRequest } from "../../src/adapters/admin-api/access-session-guard.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { PostgresAdminAccessSessionRepository } from "../../src/platform/admin/postgres-admin-access-session-repository.js";
import { PostgresAdminRegistrySeed } from "../../src/platform/admin/postgres-admin-registry-seed.js";
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

function accessSessionRequest(input: {
  principalId: string;
  fingerprint: string;
  issuedAt: Date;
  observedAt: Date;
  expiresAt: Date;
}): AdminAccessSessionUseRequest {
  return {
    principalId: input.principalId,
    environment: "staging",
    tokenFingerprint: input.fingerprint,
    accessIssuedAt: input.issuedAt,
    accessNotBefore: input.issuedAt,
    accessExpiresAt: input.expiresAt,
    observedAt: input.observedAt,
    idleExpiresAt: new Date(input.observedAt.getTime() + 15 * 60 * 1_000),
  };
}

describe.sequential("admin.session.revoke_all PostgreSQL lifecycle", () => {
  const dbName = `pokemon_admin_revoke_all_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "admin-session-revoke-all-proof" });
    await pool.connect().then(async (client) => {
      try {
        await new PostgresAdminRegistrySeed(client).reconcile();
      } finally {
        client.release();
      }
    });
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

  it("revokes every current session and blocks previously unseen pre-cutoff Access tokens", async () => {
    const proposerId = randomUUID();
    const approverId = randomUUID();
    const targetId = randomUUID();
    const ownerRole = await pool.query<{ id: string }>(
      "SELECT id FROM admin_roles WHERE slug = 'OWNER_SECURITY_ADMIN'",
    );
    const ownerRoleId = ownerRole.rows[0]?.id;
    expect(ownerRoleId).toBeDefined();

    await pool.query(
      `INSERT INTO admin_principals(id, identity_ref, status)
       VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE'), ($5, $6, 'ACTIVE')`,
      [
        proposerId,
        `proof:revoke:proposer:${proposerId}`,
        approverId,
        `proof:revoke:approver:${approverId}`,
        targetId,
        `proof:revoke:target:${targetId}`,
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
    const existingIssuedAt = new Date("2026-08-31T17:00:00.000Z");
    await expect(
      sessions.useSession(
        accessSessionRequest({
          principalId: targetId,
          fingerprint: "a".repeat(64),
          issuedAt: existingIssuedAt,
          observedAt: new Date("2026-08-31T17:30:00.000Z"),
          expiresAt: new Date("2026-08-31T23:00:00.000Z"),
        }),
      ),
    ).resolves.toBe("ACTIVE");

    const repository = new PostgresAdminRepository(pool);
    const sessionRevocation = new PostgresAdminSessionRevocationPort(pool);
    const admin = new AdminService(
      createPhase12AdminOperationRegistry(repository, sessionRevocation),
      repository,
    );
    const correlationId = randomUUID();
    const prepared = await admin.prepareMutation({
      principalId: proposerId,
      operationType: "admin.session.revoke_all",
      input: { principalId: targetId },
      reason: "incident response requires immediate administrative session revocation",
      idempotencyKey: `admin-session-revoke-all-${randomUUID()}`,
      correlationId,
    });

    expect(prepared.operation).toMatchObject({
      operationType: "admin.session.revoke_all",
      capabilityKey: "admin.session.revoke",
      targetType: "ADMIN_PRINCIPAL",
      targetId,
      riskTier: 4,
      status: "VALIDATED",
      expectedRevision: null,
    });

    const simulated = await admin.simulate(prepared.operation.id, proposerId);
    expect(simulated.status).toBe("PENDING_CONFIRMATION");
    expect(simulated.result).toMatchObject({
      simulation: {
        summary: { operation: "admin.session.revoke_all", activeSessions: 1 },
      },
    });

    const confirmed = await admin.confirm(prepared.operation.id, proposerId);
    expect(confirmed.status).toBe("PENDING_APPROVAL");
    await expect(
      admin.approve(prepared.operation.id, proposerId, "self approval is forbidden"),
    ).rejects.toMatchObject({ code: "ADMIN_SELF_APPROVAL_FORBIDDEN" });

    const approved = await admin.approve(
      prepared.operation.id,
      approverId,
      "independent security approval",
    );
    expect(approved.status).toBe("READY");

    const applied = await admin.apply(prepared.operation.id, proposerId);
    expect(applied.status).toBe("APPLIED");
    expect(applied.result).toMatchObject({ applied: true, revokedSessions: 1 });

    const target = await pool.query<{
      admin_access_sessions_revoked_before: Date;
      revision: string;
    }>(
      `SELECT admin_access_sessions_revoked_before, revision::text
       FROM admin_principals
       WHERE id = $1`,
      [targetId],
    );
    const cutoff = target.rows[0]?.admin_access_sessions_revoked_before;
    expect(cutoff).toBeInstanceOf(Date);
    expect(target.rows[0]?.revision).toBe("1");
    if (cutoff === undefined) throw new Error("Session revocation cutoff was not persisted");

    const revoked = await pool.query<{
      status: string;
      revocation_reason: string;
      revoked_by_principal_id: string;
    }>(
      `SELECT status, revocation_reason, revoked_by_principal_id
       FROM admin_access_sessions
       WHERE token_fingerprint = $1`,
      ["a".repeat(64)],
    );
    expect(revoked.rows[0]).toMatchObject({
      status: "REVOKED",
      revocation_reason: "ADMIN_REVOKE_ALL",
      revoked_by_principal_id: proposerId,
    });

    await expect(
      sessions.useSession(
        accessSessionRequest({
          principalId: targetId,
          fingerprint: "b".repeat(64),
          issuedAt: new Date(cutoff.getTime() - 60_000),
          observedAt: new Date(cutoff.getTime() + 1_000),
          expiresAt: new Date(cutoff.getTime() + 60 * 60 * 1_000),
        }),
      ),
    ).resolves.toBe("DENIED");

    await expect(
      sessions.useSession(
        accessSessionRequest({
          principalId: targetId,
          fingerprint: "c".repeat(64),
          issuedAt: new Date(cutoff.getTime() + 1_000),
          observedAt: new Date(cutoff.getTime() + 2_000),
          expiresAt: new Date(cutoff.getTime() + 60 * 60 * 1_000),
        }),
      ),
    ).resolves.toBe("ACTIVE");

    const audit = await pool.query<{
      action: string;
      actor_id: string;
      target_id: string;
      correlation_id: string;
      before_data: Record<string, unknown>;
      after_data: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, actor_id, target_id, correlation_id, before_data, after_data, metadata
       FROM audit_events
       WHERE causation_id = $1`,
      [prepared.operation.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "admin.session.revoke_all",
      actor_id: proposerId,
      target_id: targetId,
      correlation_id: correlationId,
      before_data: { activeSessions: 1 },
      after_data: { activeSessions: 0 },
      metadata: { adminOperationId: prepared.operation.id },
    });
    expect(JSON.stringify(audit.rows[0])).not.toContain("tokenFingerprint");
    expect(JSON.stringify(audit.rows[0])).not.toContain("aaaa");
  });
});
