import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_ADMIN_IDENTITY_REF,
  LocalAdminBootstrapConflictError,
  bootstrapLocalAdmin,
} from "../../src/platform/admin/postgres-local-admin-bootstrap.js";
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

describe.sequential("bootstrapLocalAdmin", () => {
  const dbName = `pokemon_local_admin_bootstrap_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "local-admin-bootstrap-proof" });
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

  it("creates one ACTIVE local owner with exactly one OWNER_SECURITY_ADMIN role and GLOBAL scope", async () => {
    const first = await bootstrapLocalAdmin(pool);
    const second = await bootstrapLocalAdmin(pool);

    expect(second).toEqual({ ...first, replayed: true });
    expect(first.replayed).toBe(false);

    const principal = await pool.query<{
      identity_ref: string;
      status: string;
      role_slug: string;
      role_count: string;
      active_global_scopes: string;
      active_scope_count: string;
    }>(
      `SELECT principal.identity_ref,
              principal.status,
              role.slug AS role_slug,
              (SELECT count(*)::text FROM admin_principal_roles relation
               WHERE relation.principal_id = principal.id) AS role_count,
              (SELECT count(*)::text FROM admin_principal_scopes scope
               WHERE scope.principal_id = principal.id
                 AND scope.status = 'ACTIVE'
                 AND scope.scope_type = 'GLOBAL'
                 AND scope.scope_id IS NULL) AS active_global_scopes,
              (SELECT count(*)::text FROM admin_principal_scopes scope
               WHERE scope.principal_id = principal.id AND scope.status = 'ACTIVE') AS active_scope_count
       FROM admin_principals principal
       JOIN admin_principal_roles relation ON relation.principal_id = principal.id
       JOIN admin_roles role ON role.id = relation.role_id
       WHERE principal.id = $1`,
      [first.principalId],
    );

    expect(principal.rows[0]).toEqual({
      identity_ref: LOCAL_ADMIN_IDENTITY_REF,
      status: "ACTIVE",
      role_slug: "OWNER_SECURITY_ADMIN",
      role_count: "1",
      active_global_scopes: "1",
      active_scope_count: "1",
    });
  });

  it("fails closed instead of silently reactivating a disabled local principal", async () => {
    const existing = await bootstrapLocalAdmin(pool);
    await pool.query("UPDATE admin_principals SET status = 'DISABLED' WHERE id = $1", [
      existing.principalId,
    ]);

    await expect(bootstrapLocalAdmin(pool)).rejects.toBeInstanceOf(
      LocalAdminBootstrapConflictError,
    );
  });
});
