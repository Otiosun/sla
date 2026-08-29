import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { OWNER_SECURITY_ADMIN_ROLE } from "../../modules/admin/registry-catalog.js";
import { withTransaction } from "../db/transaction.js";
import { reconcileCanonicalAdminRegistry } from "./postgres-admin-registry-seed.js";

const BOOTSTRAP_KEY = "INITIAL_ADMIN";
const BOOTSTRAP_ACTION = "admin.bootstrap.initial";
const BOOTSTRAP_VERSION = 1;

export interface InitialAdminBootstrapInput {
  readonly identityRef: string;
  readonly environment: "staging" | "production";
  readonly deploymentRevision: string;
}

export interface InitialAdminBootstrapResult {
  readonly principalId: string;
  readonly roleSlug: typeof OWNER_SECURITY_ADMIN_ROLE;
  readonly environment: "staging" | "production";
  readonly deploymentRevision: string;
  readonly correlationId: string;
  readonly replayed: boolean;
}

export class InitialAdminBootstrapConflictError extends Error {
  override readonly name = "InitialAdminBootstrapConflictError";
}

export class InitialAdminBootstrapExistingPrincipalError extends Error {
  override readonly name = "InitialAdminBootstrapExistingPrincipalError";
}

export class InitialAdminBootstrapPrivilegeError extends Error {
  override readonly name = "InitialAdminBootstrapPrivilegeError";
}

interface BootstrapStateRow {
  readonly principal_id: string;
  readonly role_id: string;
  readonly environment: "staging" | "production";
  readonly deployment_revision: string;
  readonly correlation_id: string;
}

async function assertMigratorOwnsBootstrapObjects(client: PoolClient): Promise<void> {
  const result = await client.query<{ mismatch_count: number; mismatched_names: string }>(
    `SELECT count(*)::integer AS mismatch_count,
            COALESCE(string_agg(c.relname, ', ' ORDER BY c.relname), '') AS mismatched_names
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY($1::text[])
       AND pg_get_userbyid(c.relowner) <> current_user`,
    [
      [
        "admin_principals",
        "admin_roles",
        "capabilities",
        "admin_role_capabilities",
        "admin_principal_roles",
        "admin_principal_scopes",
        "admin_initial_bootstrap_state",
        "audit_events",
      ],
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new InitialAdminBootstrapPrivilegeError(
      "Initial admin bootstrap could not verify schema ownership",
    );
  }
  if (row.mismatch_count > 0) {
    throw new InitialAdminBootstrapPrivilegeError(
      `Initial admin bootstrap current role does not own required objects: ${row.mismatched_names}`,
    );
  }
}

async function readBootstrapState(client: PoolClient): Promise<BootstrapStateRow | null> {
  const result = await client.query<BootstrapStateRow>(
    `SELECT principal_id, role_id, environment, deployment_revision, correlation_id
     FROM admin_initial_bootstrap_state
     WHERE singleton_key = $1`,
    [BOOTSTRAP_KEY],
  );
  return result.rows[0] ?? null;
}

async function verifyReplay(
  client: PoolClient,
  state: BootstrapStateRow,
  input: InitialAdminBootstrapInput,
): Promise<InitialAdminBootstrapResult> {
  if (
    state.environment !== input.environment ||
    state.deployment_revision !== input.deploymentRevision
  ) {
    throw new InitialAdminBootstrapConflictError(
      "Initial admin bootstrap already exists for a different release context",
    );
  }

  const principal = await client.query<{
    identity_ref: string;
    status: string;
    role_slug: string | null;
    role_count: string;
    active_global_scopes: string;
    active_scope_count: string;
    audit_count: string;
  }>(
    `SELECT principal.identity_ref,
            principal.status,
            (SELECT role.slug
             FROM admin_principal_roles relation
             JOIN admin_roles role ON role.id = relation.role_id
             WHERE relation.principal_id = principal.id AND relation.role_id = $2) AS role_slug,
            (SELECT count(*)::text FROM admin_principal_roles relation
             WHERE relation.principal_id = principal.id) AS role_count,
            (SELECT count(*)::text FROM admin_principal_scopes scope
             WHERE scope.principal_id = principal.id
               AND scope.status = 'ACTIVE'
               AND scope.scope_type = 'GLOBAL'
               AND scope.scope_id IS NULL) AS active_global_scopes,
            (SELECT count(*)::text FROM admin_principal_scopes scope
             WHERE scope.principal_id = principal.id AND scope.status = 'ACTIVE') AS active_scope_count,
            (SELECT count(*)::text FROM audit_events audit
             WHERE audit.correlation_id = $3
               AND audit.action = $4
               AND audit.target_type = 'ADMIN_PRINCIPAL'
               AND audit.target_id = principal.id) AS audit_count
     FROM admin_principals principal
     WHERE principal.id = $1`,
    [state.principal_id, state.role_id, state.correlation_id, BOOTSTRAP_ACTION],
  );
  const row = principal.rows[0];
  if (
    row === undefined ||
    row.identity_ref !== input.identityRef ||
    row.status !== "ACTIVE" ||
    row.role_slug !== OWNER_SECURITY_ADMIN_ROLE ||
    row.role_count !== "1" ||
    row.active_global_scopes !== "1" ||
    row.active_scope_count !== "1" ||
    row.audit_count !== "1"
  ) {
    throw new InitialAdminBootstrapConflictError(
      "Existing initial admin bootstrap state does not match the requested canonical state",
    );
  }

  return {
    principalId: state.principal_id,
    roleSlug: OWNER_SECURITY_ADMIN_ROLE,
    environment: state.environment,
    deploymentRevision: state.deployment_revision,
    correlationId: state.correlation_id,
    replayed: true,
  };
}

export async function bootstrapInitialAdmin(
  pool: Pool,
  input: InitialAdminBootstrapInput,
): Promise<InitialAdminBootstrapResult> {
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pokemon-rpg:initial-admin-bootstrap', 0))",
    );
    await client.query("LOCK TABLE admin_initial_bootstrap_state IN EXCLUSIVE MODE");
    await client.query("LOCK TABLE admin_principals IN SHARE ROW EXCLUSIVE MODE");
    await assertMigratorOwnsBootstrapObjects(client);

    const state = await readBootstrapState(client);
    if (state !== null) return verifyReplay(client, state, input);

    const principalCount = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM admin_principals",
    );
    if (principalCount.rows[0]?.count !== "0") {
      throw new InitialAdminBootstrapExistingPrincipalError(
        "Initial admin bootstrap refuses to adopt an unmarked existing admin principal",
      );
    }

    const registry = await reconcileCanonicalAdminRegistry(client);
    const principalId = randomUUID();
    const scopeId = randomUUID();
    const correlationId = randomUUID();
    const auditId = randomUUID();

    await client.query(
      `INSERT INTO admin_principals(id, identity_ref, status)
       VALUES ($1, $2, 'ACTIVE')`,
      [principalId, input.identityRef],
    );
    await client.query(
      `INSERT INTO admin_principal_roles(principal_id, role_id)
       VALUES ($1, $2)`,
      [principalId, registry.ownerRoleId],
    );
    await client.query(
      `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
       VALUES ($1, $2, 'GLOBAL', NULL)`,
      [scopeId, principalId],
    );

    await client.query(
      `INSERT INTO audit_events(
         id, actor_type, actor_id, action, target_type, target_id, risk_tier, reason,
         before_data, after_data, metadata, correlation_id, causation_id
       ) VALUES (
         $1, 'SYSTEM', NULL, $2, 'ADMIN_PRINCIPAL', $3, 4,
         'one-time initial administrative bootstrap', NULL, $4::jsonb, $5::jsonb, $6, NULL
       )`,
      [
        auditId,
        BOOTSTRAP_ACTION,
        principalId,
        JSON.stringify({
          status: "ACTIVE",
          roleSlug: OWNER_SECURITY_ADMIN_ROLE,
          scopeType: "GLOBAL",
        }),
        JSON.stringify({
          bootstrapVersion: BOOTSTRAP_VERSION,
          environment: input.environment,
          deploymentRevision: input.deploymentRevision,
        }),
        correlationId,
      ],
    );
    await client.query(
      `INSERT INTO admin_initial_bootstrap_state(
         singleton_key, principal_id, role_id, environment, deployment_revision, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        BOOTSTRAP_KEY,
        principalId,
        registry.ownerRoleId,
        input.environment,
        input.deploymentRevision,
        correlationId,
      ],
    );

    return {
      principalId,
      roleSlug: OWNER_SECURITY_ADMIN_ROLE,
      environment: input.environment,
      deploymentRevision: input.deploymentRevision,
      correlationId,
      replayed: false,
    };
  });
}
