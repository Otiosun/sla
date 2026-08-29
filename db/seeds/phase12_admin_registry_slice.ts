import { Pool } from "pg";
import { withTransaction } from "../../src/platform/db/transaction.js";
import { reconcileCanonicalAdminRegistry } from "../../src/platform/admin/postgres-admin-registry-seed.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
try {
  const result = await withTransaction(pool, (client) => reconcileCanonicalAdminRegistry(client));
  console.log(
    `Phase 12 admin registry seed ready: ${result.capabilityCount} capabilities, ${result.roleCount} roles`,
  );
} finally {
  await pool.end();
}
