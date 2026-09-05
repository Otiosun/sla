import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { registerReceptionAdminOperations } from "../../src/modules/admin/reception-operation-definitions.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
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

describe.sequential("reception admin audit evidence", () => {
  const dbName = `pokemon_reception_admin_audit_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let principalId: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "reception-admin-audit-vitest" });

    principalId = randomUUID();
    const roleId = randomUUID();
    await pool.query(
      "INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')",
      [principalId, "proof:reception-audit"],
    );
    await pool.query(
      "INSERT INTO admin_roles(id, slug, name) VALUES ($1, 'RECEPTION_AUDIT_TEST', 'Reception Audit Test')",
      [roleId],
    );

    for (const [key, riskTier] of [
      ["player.registration.approve", 2],
      ["community.group.manage", 3],
    ] as const) {
      const capabilityId = randomUUID();
      await pool.query("INSERT INTO capabilities(id, key, risk_tier) VALUES ($1, $2, $3)", [
        capabilityId,
        key,
        riskTier,
      ]);
      await pool.query(
        "INSERT INTO admin_role_capabilities(role_id, capability_id) VALUES ($1, $2)",
        [roleId, capabilityId],
      );
    }

    await pool.query("INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)", [
      principalId,
      roleId,
    ]);
    await pool.query(
      `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
       VALUES ($1, $2, 'GLOBAL', NULL)`,
      [randomUUID(), principalId],
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

  it("persists WhatsApp source channel with a registration-review audit target", async () => {
    const repository = new PostgresAdminRepository(pool);
    const service = new AdminService(
      registerReceptionAdminOperations(new AdminOperationRegistry()),
      repository,
    );
    const completion = new PostgresAdminOperationCompletion(pool);
    const playerId = randomUUID();
    const reviewId = randomUUID();
    const correlationId = randomUUID();

    const prepared = await service.prepareMutation({
      principalId,
      operationType: "registration.review.approve",
      input: { reviewId, playerId, sourceChannel: "WHATSAPP" },
      expectedRevision: 4,
      idempotencyKey: `review-${randomUUID()}`,
      correlationId,
    });
    expect(prepared.operation.status).toBe("READY");

    await completion.completeAppliedOperation({
      operation: prepared.operation,
      actorPrincipalId: principalId,
      resourceType: "REGISTRATION_REVIEW",
      resourceId: reviewId,
      beforeData: { status: "SUBMITTED", revision: 4 },
      afterData: { status: "APPROVED", revision: 5 },
      result: { reviewId, status: "APPROVED" },
      auditTarget: { type: "REGISTRATION_REVIEW", id: reviewId },
      auditMetadata: { sourceChannel: "WHATSAPP" },
    });

    const audit = await pool.query<{
      target_type: string;
      target_id: string;
      metadata: { sourceChannel?: string; adminOperationId?: string };
    }>(
      `SELECT target_type, target_id, metadata
       FROM audit_events
       WHERE correlation_id = $1 AND action = 'registration.review.approve'`,
      [correlationId],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({
        target_type: "REGISTRATION_REVIEW",
        target_id: reviewId,
        metadata: expect.objectContaining({
          sourceChannel: "WHATSAPP",
          adminOperationId: prepared.operation.id,
        }),
      }),
    ]);
  });

  it("persists Control Center source channel with a community-group audit target", async () => {
    const repository = new PostgresAdminRepository(pool);
    const service = new AdminService(
      registerReceptionAdminOperations(new AdminOperationRegistry()),
      repository,
    );
    const completion = new PostgresAdminOperationCompletion(pool);
    const groupId = randomUUID();
    const correlationId = randomUUID();

    const prepared = await service.prepareMutation({
      principalId,
      operationType: "community.group.manage",
      input: {
        groupId,
        sourceChannel: "CONTROL_CENTER",
        action: "RENAME",
        payload: { displayName: "Recepção Principal" },
      },
      reason: "rename reception group",
      expectedRevision: 2,
      idempotencyKey: `group-${randomUUID()}`,
      correlationId,
    });
    expect(prepared.operation.status).toBe("READY");

    await completion.completeAppliedOperation({
      operation: prepared.operation,
      actorPrincipalId: principalId,
      resourceType: "COMMUNITY_GROUP",
      resourceId: groupId,
      beforeData: { displayName: "Recepção" },
      afterData: { displayName: "Recepção Principal" },
      result: { groupId, action: "RENAME" },
      auditTarget: { type: "COMMUNITY_GROUP", id: groupId },
      auditMetadata: { sourceChannel: "CONTROL_CENTER" },
    });

    const audit = await pool.query<{
      target_type: string;
      target_id: string;
      metadata: { sourceChannel?: string };
    }>(
      `SELECT target_type, target_id, metadata
       FROM audit_events
       WHERE correlation_id = $1 AND action = 'community.group.manage'`,
      [correlationId],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({
        target_type: "COMMUNITY_GROUP",
        target_id: groupId,
        metadata: expect.objectContaining({ sourceChannel: "CONTROL_CENTER" }),
      }),
    ]);
  });
});
