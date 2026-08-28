import { SystemClock } from "./platform/clock/index.js";
import { loadConfig } from "./platform/config/env.js";
import { closeDatabasePool, createDatabasePool } from "./platform/db/database.js";
import { assertDatabaseSchemaCurrent } from "./platform/db/migrations.js";
import { JsonLineStdoutSink, StructuredLogger } from "./platform/logging/index.js";

const config = loadConfig();
const logger = new StructuredLogger(new SystemClock(), new JsonLineStdoutSink());
const pool = createDatabasePool({
  connectionString: config.databaseUrl,
  applicationName: "pokemon-rpg-runtime",
  maxConnections: config.databasePoolMax,
  connectionTimeoutMs: config.databaseConnectTimeoutMs,
  idleTimeoutMs: config.databaseIdleTimeoutMs,
  queryTimeoutMs: config.databaseQueryTimeoutMs,
  statementTimeoutMs: config.databaseStatementTimeoutMs,
  idleInTransactionSessionTimeoutMs: config.databaseIdleInTransactionTimeoutMs,
});

try {
  await assertDatabaseSchemaCurrent(pool);
  logger.log("INFO", "runtime.ready", { appEnv: config.appEnv });
} finally {
  await closeDatabasePool(pool);
}
