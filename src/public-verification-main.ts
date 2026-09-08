import { SystemClock } from "./platform/clock/index.js";
import { closeDatabasePool, createDatabasePool } from "./platform/db/database.js";
import { assertDatabaseSchemaCurrent } from "./platform/db/migrations.js";
import { JsonLineStdoutSink, StructuredLogger } from "./platform/logging/index.js";
import { createOperationalPublicVerificationApi } from "./runtime/compose-public-verification.js";
import { loadPublicVerificationRuntimeConfig } from "./runtime/public-verification-runtime-config.js";

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const publicConfig = loadPublicVerificationRuntimeConfig();
const logger = new StructuredLogger(new SystemClock(), new JsonLineStdoutSink());
const pool = createDatabasePool({
  connectionString: publicConfig.databaseUrl,
  applicationName: "pokemon-rpg-public-verification",
  maxConnections: publicConfig.databasePoolMax,
  connectionTimeoutMs: publicConfig.databaseConnectTimeoutMs,
  idleTimeoutMs: publicConfig.databaseIdleTimeoutMs,
  queryTimeoutMs: publicConfig.databaseQueryTimeoutMs,
  statementTimeoutMs: publicConfig.databaseStatementTimeoutMs,
  idleInTransactionSessionTimeoutMs: publicConfig.databaseIdleInTransactionTimeoutMs,
});
const api = createOperationalPublicVerificationApi(pool, publicConfig);
const shutdown = new AbortController();
const requestShutdown = (): void => shutdown.abort();

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  await assertDatabaseSchemaCurrent(pool);
  const address = await api.listen();
  logger.log("INFO", "public_verification.ready", {
    appEnv: publicConfig.appEnv,
    address,
    mode: "get-only",
    portSource: process.env.PUBLIC_VERIFICATION_PORT === undefined ? "default" : "environment",
  });
  await waitForAbort(shutdown.signal);
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
  await api.close();
  await closeDatabasePool(pool);
}
