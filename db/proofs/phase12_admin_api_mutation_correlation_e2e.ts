import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";
import { AdminMutationFacade } from "../../src/adapters/admin-api/mutation-facade.js";
import { ExternalAdminMutationEndpoint } from "../../src/modules/anti-abuse/external-admin-endpoint.js";
import { AdminOperationAuditService } from "../../src/modules/admin/audit-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { PostgresAdminApiRateLimiter } from "../../src/platform/admin/postgres-admin-api-rate-limiter.js";
import { PostgresAdminOperationAuditRepository } from "../../src/platform/admin/postgres-admin-audit-repository.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresMutationAdmission } from "../../src/platform/anti-abuse/postgres-mutation-admission.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const allowedOrigin = "https://admin-staging.example.com";
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
  const clientCorrelationId = randomUUID();

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
  const server = createAdminApiServer({
    allowedOrigin,
    authenticator: {
      authenticate: async () => ({
        principalId: proposerId,
        environment: "staging",
        identityRef: `proof:admin-api:proposer:${proposerId}`,
        displayEmail: null,
      }),
    },
    sessionService: {
      getSession: async () => {
        throw new Error("session route is not part of this proof");
      },
    },
    readFacade: {
      searchPlayers: async () => {
        throw new Error("player search is not part of this proof");
      },
      getPlayer: async () => {
        throw new Error("player read is not part of this proof");
      },
    },
    mutationFacade,
    rateLimiter: new PostgresAdminApiRateLimiter(pool),
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/admin/v1/operations/prepare",
      headers: {
        origin: allowedOrigin,
        "cf-access-jwt-assertion": "proof-token",
        "x-correlation-id": clientCorrelationId,
      },
      payload: {
        operationType: "admin.role.assign",
        input: { principalId: targetAdminId, roleId: supportRoleId },
        reason: "trusted Admin API HTTP correlation proof",
        expectedRevision: "0",
        idempotencyKey: `admin-api-http-correlation-${randomUUID()}`,
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(`Admin API HTTP mutation preparation failed with ${response.statusCode}`);
    }

    const correlationId = response.headers["x-correlation-id"];
    if (typeof correlationId !== "string" || correlationId === clientCorrelationId) {
      throw new Error("HTTP mutation preparation did not generate server-owned correlation");
    }

    const body = response.json<{
      operation: { id: string; correlationId: string; expectedRevision: string | null };
      replayed: boolean;
    }>();
    if (
      body.operation.correlationId !== correlationId ||
      body.operation.expectedRevision !== "0" ||
      body.replayed
    ) {
      throw new Error("HTTP mutation preparation response projection is inconsistent");
    }

    const persisted = await pool.query<{ correlation_id: string; principal_id: string }>(
      `SELECT correlation_id, principal_id FROM admin_operations WHERE id = $1`,
      [body.operation.id],
    );
    if (
      persisted.rows[0]?.correlation_id !== correlationId ||
      persisted.rows[0]?.principal_id !== proposerId
    ) {
      throw new Error("HTTP server correlation/principal did not persist in admin_operations");
    }

    await mutationEndpoint.simulate(body.operation.id, proposerId);
    await mutationEndpoint.confirm(body.operation.id, proposerId);
    await mutationEndpoint.approve(
      body.operation.id,
      approverId,
      "independent HTTP correlation proof approval",
    );
    const applied = await mutationEndpoint.apply(body.operation.id, proposerId);
    if (applied.status !== "APPLIED") {
      throw new Error("Admin API HTTP correlation proof operation did not apply");
    }

    const trail = await audit.inspect({ principalId: proposerId, operationId: body.operation.id });
    const event = trail.auditEvents[0];
    if (
      trail.operation.correlationId !== correlationId ||
      trail.operation.principalId !== proposerId ||
      event?.correlationId !== correlationId ||
      event.causationId !== body.operation.id ||
      event.metadata.adminOperationId !== body.operation.id
    ) {
      throw new Error("HTTP correlation is not reconstructable through AdminOperation audit");
    }

    console.log(
      "phase12 Admin API HTTP correlation proof passed: POST -> admission -> operation -> audit",
    );
  } finally {
    await server.close();
  }
} finally {
  await pool.end();
}
