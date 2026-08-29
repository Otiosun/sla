import { Pool } from "pg";
import { bootstrapInitialAdmin } from "../../src/platform/admin/postgres-initial-admin-bootstrap.js";
import { assertDatabaseSchemaCurrent } from "../../src/platform/db/migrations.js";
import { loadInitialAdminBootstrapConfig } from "../../src/operations/initial-admin-bootstrap-config.js";

const config = loadInitialAdminBootstrapConfig();
const pool = new Pool({
  connectionString: config.migratorDatabaseUrl,
  application_name: "pokemon-rpg-initial-admin-bootstrap",
  max: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
});

try {
  await assertDatabaseSchemaCurrent(pool);
  const result = await bootstrapInitialAdmin(pool, {
    identityRef: config.identityRef,
    environment: config.appEnv,
    deploymentRevision: config.deploymentRevision,
  });
  process.stdout.write(
    `${JSON.stringify({
      event: "admin.bootstrap.initial.complete",
      principalId: result.principalId,
      roleSlug: result.roleSlug,
      environment: result.environment,
      deploymentRevision: result.deploymentRevision,
      correlationId: result.correlationId,
      replayed: result.replayed,
    })}\n`,
  );
} finally {
  await pool.end();
}
