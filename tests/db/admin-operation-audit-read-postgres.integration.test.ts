import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdminOperationAuditReadRepository } from "../../src/platform/admin/postgres-admin-operation-audit-read-repository.js";
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

describe.sequential("PostgresAdminOperationAuditReadRepository", () => {
  const dbName = `pokemon_admin_audit_read_${process.pid}_${Date.now()}`;
  const operationId = "22222222-2222-4222-8222-222222222222";
  const actorId = "11111111-1111-4111-8111-111111111111";
  const approverId = "33333333-3333-4333-8333-333333333333";
  const targetId = "44444444-4444-4444-8444-444444444444";
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "admin-operation-audit-read-proof" });

    await pool.query(
      `INSERT INTO admin_principals(id, identity_ref, status)
       VALUES
       ($1, 'audit-read-actor', 'ACTIVE'),
       ($2, 'audit-read-approver', 'ACTIVE')`,
      [actorId, approverId],
    );

    await pool.query(
      `INSERT INTO admin_operations(
         id, principal_id, capability_key, operation_type, target_type, target_id,
         risk_tier, status, reason, expected_revision, idempotency_key, input, result,
         correlation_id, request_fingerprint, revision, created_at, updated_at, applied_at,
         policy_version, authorization_mode, requires_reason, requires_expected_revision,
         requires_simulation, requires_confirmation, required_approvals
       ) VALUES (
         $1, $2, 'admin.role.assign', 'admin.role.assign', 'ADMIN_PRINCIPAL', $3,
         4, 'APPLIED', 'SECRET_OPERATION_REASON', 7, 'audit-read-operation-key',
         $4::jsonb, $5::jsonb, $6, 'SECRET_REQUEST_FINGERPRINT', 4,
         $7, $8, $8, 1, 'GLOBAL_ONLY', TRUE, TRUE, TRUE, TRUE, 1
       )`,
      [
        operationId,
        actorId,
        targetId,
        JSON.stringify({ secret: "SECRET_OPERATION_INPUT" }),
        JSON.stringify({ secret: "SECRET_OPERATION_RESULT" }),
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        new Date("2026-09-01T12:00:00.000Z"),
        new Date("2026-09-01T12:04:00.000Z"),
      ],
    );

    await pool.query(
      `INSERT INTO admin_operation_confirmations(
         id, admin_operation_id, principal_id, request_fingerprint, created_at
       ) VALUES ($1, $2, $3, 'SECRET_CONFIRMATION_FINGERPRINT', $4)`,
      [
        "55555555-5555-4555-8555-555555555555",
        operationId,
        actorId,
        new Date("2026-09-01T12:02:00.000Z"),
      ],
    );

    await pool.query(
      `INSERT INTO admin_operation_approvals(
         id, admin_operation_id, principal_id, request_fingerprint, decision, reason, created_at
       ) VALUES ($1, $2, $3, 'SECRET_APPROVAL_FINGERPRINT', 'APPROVED', 'SECRET_APPROVAL_REASON', $4)`,
      [
        "66666666-6666-4666-8666-666666666666",
        operationId,
        approverId,
        new Date("2026-09-01T12:03:00.000Z"),
      ],
    );

    await pool.query(
      `INSERT INTO admin_operation_changes(
         id, admin_operation_id, resource_type, resource_id, before_data, after_data, created_at
       ) VALUES ($1, $2, 'ADMIN_PRINCIPAL', $3, $4::jsonb, $5::jsonb, $6)`,
      [
        "77777777-7777-4777-8777-777777777777",
        operationId,
        targetId,
        JSON.stringify({ secret: "SECRET_BEFORE" }),
        JSON.stringify({ secret: "SECRET_AFTER" }),
        new Date("2026-09-01T12:04:00.000Z"),
      ],
    );

    await pool.query(
      `INSERT INTO audit_events(
         id, actor_type, actor_id, action, target_type, target_id, risk_tier, reason,
         before_data, after_data, metadata, correlation_id, causation_id, occurred_at
       ) VALUES
       ($1, 'ADMIN', $2, 'admin.role.assign', 'ADMIN_PRINCIPAL', $3, 4,
        'SECRET_AUDIT_REASON', $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9),
       ($10, 'ADMIN', $2, 'unrelated.same-correlation', 'ADMIN_PRINCIPAL', $3, 4,
        'SECRET_DISTRACTOR_REASON', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $7, $11, $9)`,
      [
        "88888888-8888-4888-8888-888888888888",
        actorId,
        targetId,
        JSON.stringify({ secret: "SECRET_AUDIT_BEFORE" }),
        JSON.stringify({ secret: "SECRET_AUDIT_AFTER" }),
        JSON.stringify({ secret: "SECRET_AUDIT_METADATA" }),
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        operationId,
        new Date("2026-09-01T12:04:00.000Z"),
        "99999999-9999-4999-8999-999999999999",
        "aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa",
      ],
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

  it("reconstructs only events causally bound to the exact operation", async () => {
    const repository = new PostgresAdminOperationAuditReadRepository(pool);
    const result = await repository.reconstruct(operationId);

    expect(result?.timeline.map((event) => [event.kind, event.action])).toEqual([
      ["PROPOSED", "admin.role.assign.proposed"],
      ["CONFIRMATION", "admin.role.assign.confirmation"],
      ["APPROVAL", "admin.role.assign.approval"],
      ["CHANGE", "admin.role.assign.change"],
      ["AUDIT", "admin.role.assign"],
    ]);
    expect(result?.timeline.some((event) => event.action === "unrelated.same-correlation")).toBe(
      false,
    );
  });

  it("never selects or projects raw operation/audit/change/approval secrets", async () => {
    const repository = new PostgresAdminOperationAuditReadRepository(pool);
    const serialized = JSON.stringify(await repository.reconstruct(operationId));
    for (const secret of [
      "SECRET_OPERATION_REASON",
      "SECRET_OPERATION_INPUT",
      "SECRET_OPERATION_RESULT",
      "SECRET_REQUEST_FINGERPRINT",
      "SECRET_CONFIRMATION_FINGERPRINT",
      "SECRET_APPROVAL_FINGERPRINT",
      "SECRET_APPROVAL_REASON",
      "SECRET_BEFORE",
      "SECRET_AFTER",
      "SECRET_AUDIT_REASON",
      "SECRET_AUDIT_BEFORE",
      "SECRET_AUDIT_AFTER",
      "SECRET_AUDIT_METADATA",
      "SECRET_DISTRACTOR_REASON",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
