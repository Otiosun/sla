import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AdminMutationFacade } from "../../src/adapters/admin-api/mutation-facade.js";
import {
  ExternalAdminMutationEndpoint,
} from "../../src/modules/anti-abuse/external-admin-endpoint.js";
import { AdminOperationAuditService } from "../../src/modules/admin/audit-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { AdminService } from "../../src/modules/admin/service.js";
import {
  PostgresAdminOperationAuditRepository,
} from "../../src/platform/admin/postgres-admin-audit-repository.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import {
  PostgresMutationAdmission,
} from "../../src/platform/anti-abuse/postgres-mutation-admission.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const ownerRoleResult = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'OWNER_SECURITY_ADMIN'`,
  );
  const supportRoleResult = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SUPPORT'`,
  );
  const ownerRoleId = ownerRoleResult.rows[0]?.id;
  const supportRoleId = supportRoleResult.rows[0]?.id;
  if (ownerRoleId === undefined || supportRoleId === undefined) {
    throw new Error("Admin mutation correlation proof roles are not seeded");
  }

  const proposerId = randomUUID();
  const approverId = randomUUID();
  const targetAdminId = randomUUID();
  const correlationId = randomUUID();

  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE'), ($5, $6, 'ACTIVE')`,
    [
      proposerId,
      `proof:admin-api:proposer:${proposerId}`,
      approverId,
      `proof:admin-api:approver:${approverId}`,
      targetAdminId,
      `proof:admin-api:target:${targetAdminId}`,
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

  const adminRepository = new PostgresAdminRepository(pool);
  const admin = new AdminService(
    createPhase12AdminOperationRegistry(adminRepository),
    adminRepository,
  );
  const mutationEndpoint = new ExternalAdminMutationEndpoint(
    admin,
    new PostgresMutationAdmission(pool),
  );
  const mutationFacade = new AdminMutationFacade(mutationEndpoint);
  const audit = new AdminOperationAuditService(
    admin,
    new PostgresAdminOperationAuditRepository(pool),
  );

  const prepared = await mutationFacade.prepareMutation(
    {
      principalId: proposerId,
      environment: "staging",
      correlationId,
    },
    {
      operationType: "admin.role.assign",
      input: { principalId: targetAdminId, roleId: supportRoleId },
      reason: "trusted Admin API correlation proof",
      expectedRevision: "0",
      idempotencyKey: `admin-api-correlation-${randomUUID()}`,
    },
  );

  if (prepared.operation.correlationId !== correlationId) {
    throw new Error("Trusted correlation did not reach the prepared AdminOperation");
  }

  const persisted = await pool.query<{ correlation_id: string }>(
    `SELECT correlation_id FROM admin_operations WHERE id = $1`,
    [prepared.operation.id],
  );
  if (persisted.rows[0]?.correlation_id !== correlationId) {
    throw new Error("Trusted correlation did not persist in admin_operations");
  }

  await mutationEndpoint.simulate(prepared.operation.id, proposerId);
  await mutationEndpoint.confirm(prepared.operation.id, proposerId);
  await mutationEndpoint.approve(
    prepared.operation.id,
    approverId,
    "independent correlation proof approval",
  );
  const applied = await mutationEndpoint.apply(prepared.operation.id, proposerId);
  if (applied.status !== "APPLIED") {
    throw new Error("Admin API correlation proof operation did not apply");
  }

  const trail = await audit.inspect({
    principalId: proposerId,
    operationId: prepared.operation.id,
  });
  const event = trail.auditEvents[0];
  if (
    trail.operation.correlationId !== correlationId ||
    trail.operation.principalId !== proposerId ||
    event?.correlationId !== correlationId ||
    event.causationId !== prepared.operation.id ||
    event.metadata.adminOperationId !== prepared.operation.id
  ) {
    throw new Error("Trusted Admin API correlation is not reconstructable through audit");
  }

  console.log(
    "phase12 Admin API mutation correlation proof passed: trusted context -> admission -> operation -> audit",
  );
} finally {
  await pool.end();
}
