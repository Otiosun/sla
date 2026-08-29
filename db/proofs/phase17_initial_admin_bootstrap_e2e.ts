import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { ADMIN_CAPABILITIES, OWNER_SECURITY_ADMIN_ROLE } from "../../src/modules/admin/registry-catalog.js";
import { loadInitialAdminBootstrapConfig } from "../../src/operations/initial-admin-bootstrap-config.js";
import {
  bootstrapInitialAdmin,
  InitialAdminBootstrapExistingPrincipalError,
} from "../../src/platform/admin/postgres-initial-admin-bootstrap.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";

const config = loadInitialAdminBootstrapConfig();

interface CliResult {
  readonly event: string;
  readonly principalId: string;
  readonly roleSlug: string;
  readonly correlationId: string;
  readonly replayed: boolean;
}

function runCli(env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/operations/bootstrap-initial-admin.ts"],
    { env, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Initial admin bootstrap CLI failed: ${result.stderr}`);
  }
  const line = result.stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("Initial admin bootstrap CLI returned no result");
  return JSON.parse(line) as CliResult;
}

async function deleteBootstrapEvidence(pool: Pool, principalId: string, correlationId: string): Promise<void> {
  await pool.query("DELETE FROM admin_initial_bootstrap_state WHERE singleton_key = 'INITIAL_ADMIN'");
  await pool.query("DELETE FROM audit_events WHERE correlation_id = $1", [correlationId]);
  await pool.query("DELETE FROM admin_principal_scopes WHERE principal_id = $1", [principalId]);
  await pool.query("DELETE FROM admin_principal_roles WHERE principal_id = $1", [principalId]);
  await pool.query("DELETE FROM admin_principals WHERE id = $1", [principalId]);
}

const migratorPool = new Pool({ connectionString: config.migratorDatabaseUrl, max: 4 });
const runtimePool = new Pool({ connectionString: config.runtimeDatabaseUrl, max: 2 });
try {
  const initialCounts = await migratorPool.query<{ principals: string; marker: string }>(
    `SELECT
       (SELECT count(*)::text FROM admin_principals) AS principals,
       (SELECT count(*)::text FROM admin_initial_bootstrap_state) AS marker`,
  );
  if (initialCounts.rows[0]?.principals !== "0" || initialCounts.rows[0]?.marker !== "0") {
    throw new Error("Initial admin bootstrap proof requires an unbootstrapped disposable database");
  }

  const first = runCli(process.env);
  if (
    first.event !== "admin.bootstrap.initial.complete" ||
    first.roleSlug !== OWNER_SECURITY_ADMIN_ROLE ||
    first.replayed
  ) {
    throw new Error("Initial admin bootstrap CLI did not create the expected first owner");
  }

  const replay = runCli(process.env);
  if (
    !replay.replayed ||
    replay.principalId !== first.principalId ||
    replay.correlationId !== first.correlationId
  ) {
    throw new Error("Exact initial admin bootstrap replay did not converge idempotently");
  }

  const differentIdentity = "proof:different-owner";
  const conflict = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/operations/bootstrap-initial-admin.ts"],
    {
      env: { ...process.env, ADMIN_BOOTSTRAP_IDENTITY_REF: differentIdentity },
      encoding: "utf8",
    },
  );
  if (conflict.status === 0) {
    throw new Error("Initial admin bootstrap unexpectedly accepted a different identity replay");
  }
  if (`${conflict.stdout}\n${conflict.stderr}`.includes(differentIdentity)) {
    throw new Error("Rejected initial admin identity leaked into CLI output");
  }

  const persisted = await migratorPool.query<{
    identity_ref: string;
    principal_status: string;
    role_slug: string;
    scope_type: string;
    marker_count: string;
    audit_count: string;
    capability_count: string;
  }>(
    `SELECT principal.identity_ref,
            principal.status AS principal_status,
            role.slug AS role_slug,
            scope.scope_type,
            (SELECT count(*)::text FROM admin_initial_bootstrap_state) AS marker_count,
            (SELECT count(*)::text FROM audit_events audit
             WHERE audit.correlation_id = $2 AND audit.action = 'admin.bootstrap.initial') AS audit_count,
            (SELECT count(*)::text
             FROM admin_role_capabilities relation
             WHERE relation.role_id = role.id) AS capability_count
     FROM admin_principals principal
     JOIN admin_principal_roles principal_role ON principal_role.principal_id = principal.id
     JOIN admin_roles role ON role.id = principal_role.role_id
     JOIN admin_principal_scopes scope ON scope.principal_id = principal.id AND scope.status = 'ACTIVE'
     WHERE principal.id = $1`,
    [first.principalId, first.correlationId],
  );
  const row = persisted.rows[0];
  if (
    row === undefined ||
    row.identity_ref !== config.identityRef ||
    row.principal_status !== "ACTIVE" ||
    row.role_slug !== OWNER_SECURITY_ADMIN_ROLE ||
    row.scope_type !== "GLOBAL" ||
    row.marker_count !== "1" ||
    row.audit_count !== "1" ||
    Number(row.capability_count) !== ADMIN_CAPABILITIES.length
  ) {
    throw new Error("Initial admin bootstrap persisted an incomplete administrative state");
  }

  const repository = new PostgresAdminRepository(runtimePool);
  const authorization = await repository.getAuthorizationSnapshot(first.principalId);
  if (
    authorization === null ||
    authorization.status !== "ACTIVE" ||
    authorization.capabilities.length !== ADMIN_CAPABILITIES.length ||
    authorization.scopes.length !== 1 ||
    authorization.scopes[0]?.scopeType !== "GLOBAL" ||
    authorization.scopes[0]?.scopeId !== null
  ) {
    throw new Error("Restricted runtime cannot resolve the bootstrapped owner authorization snapshot");
  }

  const runtimePrivileges = await runtimePool.query<{
    can_select: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
    can_truncate: boolean;
  }>(
    `SELECT
       has_table_privilege(current_user, 'public.admin_initial_bootstrap_state', 'SELECT') AS can_select,
       has_table_privilege(current_user, 'public.admin_initial_bootstrap_state', 'INSERT') AS can_insert,
       has_table_privilege(current_user, 'public.admin_initial_bootstrap_state', 'UPDATE') AS can_update,
       has_table_privilege(current_user, 'public.admin_initial_bootstrap_state', 'DELETE') AS can_delete,
       has_table_privilege(current_user, 'public.admin_initial_bootstrap_state', 'TRUNCATE') AS can_truncate`,
  );
  const privileges = runtimePrivileges.rows[0];
  if (
    privileges?.can_select !== true ||
    privileges.can_insert ||
    privileges.can_update ||
    privileges.can_delete ||
    privileges.can_truncate
  ) {
    throw new Error("Runtime privilege policy does not keep the bootstrap marker read-only");
  }

  await deleteBootstrapEvidence(migratorPool, first.principalId, first.correlationId);
  const roguePrincipalId = randomUUID();
  await migratorPool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, 'proof:rogue-preexisting', 'ACTIVE')`,
    [roguePrincipalId],
  );
  try {
    await bootstrapInitialAdmin(migratorPool, {
      identityRef: config.identityRef,
      environment: config.appEnv,
      deploymentRevision: config.deploymentRevision,
    });
    throw new Error("Initial admin bootstrap unexpectedly adopted a pre-existing unmarked principal");
  } catch (error) {
    if (!(error instanceof InitialAdminBootstrapExistingPrincipalError)) throw error;
  } finally {
    await migratorPool.query("DELETE FROM admin_principals WHERE id = $1", [roguePrincipalId]);
  }

  const final = runCli(process.env);
  if (final.replayed) throw new Error("Final bootstrap reconstruction unexpectedly replayed missing state");

  process.stdout.write(
    `${JSON.stringify({
      proof: "phase17-initial-admin-bootstrap",
      role: OWNER_SECURITY_ADMIN_ROLE,
      capabilities: ADMIN_CAPABILITIES.length,
      exactReplayIdempotent: true,
      conflictingIdentityDenied: true,
      unmarkedPrincipalDenied: true,
      runtimeMarkerReadOnly: true,
      finalPrincipalId: final.principalId,
    })}\n`,
  );
} finally {
  await Promise.all([runtimePool.end(), migratorPool.end()]);
}
