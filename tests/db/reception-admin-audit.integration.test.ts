import { randomUUID } from "node:crypto";
import { CommunityService } from "../../src/modules/community/service.js";
import { CommunityGroupAdminService } from "../../src/modules/admin/community-group-service.js";
import { PostgresCommunityRepository } from "../../src/platform/community/postgres-community-repository.js";
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

  it("applies REPLACE_CAPABILITIES through community.group.manage", async () => {
    const groupId = randomUUID();
    const correlationId = randomUUID();

    await pool.query(
      "INSERT INTO community_groups(id,provider,chat_ref,role,display_name) VALUES ($1,'baileys',$2,'GAME','UAT PVE')",
      [groupId, `120363${Date.now()}@g.us`],
    );

    await pool.query(
      "INSERT INTO community_group_capabilities(group_id,capability_key) VALUES ($1,'player.basic'),($1,'world')",
      [groupId],
    );

    const community = new CommunityService(new PostgresCommunityRepository(pool));
    const owner = new CommunityGroupAdminService({
      community,
      completion: new PostgresAdminOperationCompletion(pool),
    });

    const service = new AdminService(
      registerReceptionAdminOperations(new AdminOperationRegistry(), {
        communityGroup: owner,
      }),
      new PostgresAdminRepository(pool),
    );

    const prepared = await service.prepareMutation({
      principalId,
      operationType: "community.group.manage",
      input: {
        groupId,
        sourceChannel: "WHATSAPP",
        action: "REPLACE_CAPABILITIES",
        payload: {
          capabilities: ["player.basic", "pve", "world"],
        },
      },
      reason: "enable pve for game group",
      expectedRevision: 0,
      idempotencyKey: `group-pve-${randomUUID()}`,
      correlationId,
    });

    const applied = await service.apply(prepared.operation.id, principalId);

    expect(applied.status).toBe("APPLIED");

    expect(
      (
        await pool.query(
          "SELECT revision::int FROM community_groups WHERE id=$1",
          [groupId],
        )
      ).rows,
    ).toEqual([{ revision: 1 }]);

    expect(
      (
        await pool.query(
          "SELECT capability_key FROM community_group_capabilities WHERE group_id=$1 AND active ORDER BY capability_key",
          [groupId],
        )
      ).rows,
    ).toEqual([
      { capability_key: "player.basic" },
      { capability_key: "pve" },
      { capability_key: "world" },
    ]);

    expect(
      (
        await pool.query(
          "SELECT action,target_type,target_id FROM audit_events WHERE correlation_id=$1",
          [correlationId],
        )
      ).rows,
    ).toEqual([
      {
        action: "community.group.manage",
        target_type: "COMMUNITY_GROUP",
        target_id: groupId,
      },
    ]);
  });

});
