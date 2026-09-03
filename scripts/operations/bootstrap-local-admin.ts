import { Pool } from "pg";
import { bootstrapLocalAdmin } from "../../src/platform/admin/postgres-local-admin-bootstrap.js";
import { assertDatabaseSchemaCurrent } from "../../src/platform/db/migrations.js";
import { loadLocalAdminBootstrapConfig } from "../../src/operations/local-admin-bootstrap-config.js";

const config = loadLocalAdminBootstrapConfig();
const pool = new Pool({
  connectionString: config.migratorDatabaseUrl,
  application_name: "pokemon-rpg-local-admin-bootstrap",
  max: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
});

try {
  await assertDatabaseSchemaCurrent(pool);
  const result = await bootstrapLocalAdmin(pool);
  process.stdout.write(
    `${JSON.stringify({
      event: "admin.bootstrap.local.complete",
      principalId: result.principalId,
      roleSlug: result.roleSlug,
      replayed: result.replayed,
      env: {
        ADMIN_LOCAL_DEV_PRINCIPAL_ID: result.principalId,
      },
    })}\n`,
  );
} finally {
  await pool.end();
}
