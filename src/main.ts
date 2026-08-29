import { PostgresBaileysAuthBinding } from "./adapters/whatsapp/postgres-baileys-auth.js";
import { SystemClock } from "./platform/clock/index.js";
import { loadConfig } from "./platform/config/env.js";
import { closeDatabasePool, createDatabasePool } from "./platform/db/database.js";
import { assertDatabaseSchemaCurrent } from "./platform/db/migrations.js";
import { JsonLineStdoutSink, StructuredLogger } from "./platform/logging/index.js";
import { createOperationalWhatsAppRuntime } from "./runtime/compose-whatsapp-runtime.js";
import { loadWhatsAppRuntimeConfig } from "./runtime/whatsapp-runtime-config.js";
import { WhatsAppRuntimeSupervisor } from "./runtime/whatsapp-runtime-supervisor.js";

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

let auth: PostgresBaileysAuthBinding | null = null;
const shutdown = new AbortController();
const requestShutdown = (): void => shutdown.abort();

try {
  await assertDatabaseSchemaCurrent(pool);
  const runtimeConfig = loadWhatsAppRuntimeConfig(config);
  if (runtimeConfig === null) {
    logger.log("INFO", "runtime.ready", { appEnv: config.appEnv, mode: "schema-only" });
  } else {
    auth = await PostgresBaileysAuthBinding.open(pool, {
      sessionKey: runtimeConfig.sessionKey,
      encryptionKey: runtimeConfig.authEncryptionKey,
      encryptionKeyVersion: runtimeConfig.authEncryptionKeyVersion,
      allowCreate: false,
    });
    const runtime = createOperationalWhatsAppRuntime({
      pool,
      auth,
      logger,
      onSessionInvalidated: requestShutdown,
    });
    const supervisor = new WhatsAppRuntimeSupervisor(runtime, {
      pollIntervalMs: runtimeConfig.outboxPollMs,
      logger,
    });

    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);
    logger.log("INFO", "runtime.ready", { appEnv: config.appEnv, mode: "whatsapp" });
    await supervisor.run(shutdown.signal);
  }
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
  await auth?.close();
  await closeDatabasePool(pool);
}
