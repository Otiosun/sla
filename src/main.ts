import { PostgresBaileysAuthBinding } from "./adapters/whatsapp/postgres-baileys-auth.js";
import { SystemClock } from "./platform/clock/index.js";
import { loadConfig } from "./platform/config/env.js";
import { closeDatabasePool, createDatabasePool } from "./platform/db/database.js";
import { assertDatabaseSchemaCurrent } from "./platform/db/migrations.js";
import { JsonLineStdoutSink, StructuredLogger } from "./platform/logging/index.js";
import {
  createOperationalAdminApi,
  type OperationalAdminApi,
} from "./runtime/compose-admin-api.js";
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
let adminApi: OperationalAdminApi | null = null;
const shutdown = new AbortController();
const requestShutdown = (): void => shutdown.abort();

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

try {
  await assertDatabaseSchemaCurrent(pool);
  adminApi = createOperationalAdminApi(pool, config);
  const runtimeConfig = loadWhatsAppRuntimeConfig(config);
  const longRunning = adminApi !== null || runtimeConfig !== null;

  if (longRunning) {
    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);
  }

  if (adminApi !== null) {
    const address = await adminApi.listen();
    logger.log("INFO", "admin_api.ready", {
      appEnv: config.appEnv,
      address,
      access: "cloudflare-access",
      mode: "read-only",
    });
  }

  if (runtimeConfig === null) {
    if (adminApi === null) {
      logger.log("INFO", "runtime.ready", { appEnv: config.appEnv, mode: "schema-only" });
    } else {
      logger.log("INFO", "runtime.ready", { appEnv: config.appEnv, mode: "admin-api" });
      await waitForAbort(shutdown.signal);
    }
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

    logger.log("INFO", "runtime.ready", {
      appEnv: config.appEnv,
      mode: adminApi === null ? "whatsapp" : "whatsapp+admin-api",
    });
    await supervisor.run(shutdown.signal);
  }
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
  await adminApi?.close();
  await auth?.close();
  await closeDatabasePool(pool);
}
