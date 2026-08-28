import { SystemClock } from "../clock/index.js";
import { loadConfig } from "../config/env.js";
import { JsonLineStdoutSink, StructuredLogger } from "../logging/index.js";
import { closeDatabasePool, createDatabasePool } from "./database.js";
import { assertDatabaseSchemaCurrent, runMigrations } from "./migrations.js";

const command = process.argv[2];
const config = loadConfig();
const logger = new StructuredLogger(new SystemClock(), new JsonLineStdoutSink());
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
    logger.log("INFO", "database.migrations.current", { migrationCount: migrations.length });
  } else if (command === "verify") {
    await assertDatabaseSchemaCurrent(pool);
    logger.log("INFO", "database.schema.verified");
  } else {
    throw new Error("Usage: db:cli migrate|verify");
  }
} finally {
  await closeDatabasePool(pool);
}
