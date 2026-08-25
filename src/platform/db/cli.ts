import { loadConfig } from "../config/env.js";
import { closeDatabasePool, createDatabasePool } from "./database.js";
import { assertDatabaseSchemaCurrent, runMigrations } from "./migrations.js";

const command = process.argv[2];
const config = loadConfig();
const migrationConnectionString = config.migratorDatabaseUrl ?? config.databaseUrl;
const pool = createDatabasePool({
  connectionString: command === "migrate" ? migrationConnectionString : config.databaseUrl,
  applicationName: command === "migrate" ? "pokemon-rpg-migrator" : "pokemon-rpg-schema-check",
  maxConnections: command === "migrate" ? 1 : config.databasePoolMax,
  connectionTimeoutMs: config.databaseConnectTimeoutMs,
  idleTimeoutMs: config.databaseIdleTimeoutMs,
  queryTimeoutMs: command === "migrate" ? 0 : config.databaseQueryTimeoutMs,
  statementTimeoutMs: command === "migrate" ? 0 : config.databaseStatementTimeoutMs,
  idleInTransactionSessionTimeoutMs: config.databaseIdleInTransactionTimeoutMs,
});

try {
  if (command === "migrate") {
    const migrations = await runMigrations(pool, {
      appliedBy: process.env.MIGRATION_APPLIED_BY ?? null,
    });
    console.info(`Schema current at migration ${migrations.length.toString().padStart(4, "0")}.`);
  } else if (command === "verify") {
    await assertDatabaseSchemaCurrent(pool);
    console.info("Database schema matches immutable migration files.");
  } else {
    throw new Error("Usage: db:cli migrate|verify");
  }
} finally {
  await closeDatabasePool(pool);
}
