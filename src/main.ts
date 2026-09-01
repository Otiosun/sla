import { randomUUID } from "node:crypto";
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
import { PostgresRuntimeHealthRepository } from "./runtime/postgres-runtime-health.js";
import { ReleaseRuntimeHealth } from "./runtime/release-runtime-health.js";
import { ReleaseRuntimeProcess } from "./runtime/release-runtime-process.js";
import { createReleaseRuntimeRegistration } from "./runtime/release-runtime-registration.js";
import { RuntimeTerminationController } from "./runtime/runtime-termination-controller.js";
import { loadWhatsAppRuntimeConfig } from "./runtime/whatsapp-runtime-config.js";
import { WhatsAppRuntimeSupervisor } from "./runtime/whatsapp-runtime-supervisor.js";

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

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
let removeSignalHandlers = (): void => {};

try {
  await assertDatabaseSchemaCurrent(pool);
  adminApi = createOperationalAdminApi(pool, config);
  if (adminApi !== null) {
    const address = await adminApi.listen();
    logger.log("INFO", "admin_api.ready", {
      appEnv: config.appEnv,
      address,
      access: "cloudflare-access",
      mode: "read+prepare",
    });
  }

  const runtimeConfig = loadWhatsAppRuntimeConfig(config);
  if (runtimeConfig === null) {
    if (adminApi === null) {
      logger.log("INFO", "runtime.ready", { appEnv: config.appEnv, mode: "schema-only" });
    } else {
      const shutdown = new AbortController();
      const requestShutdown = (): void => shutdown.abort();
      process.once("SIGINT", requestShutdown);
      process.once("SIGTERM", requestShutdown);
      removeSignalHandlers = () => {
        process.removeListener("SIGINT", requestShutdown);
        process.removeListener("SIGTERM", requestShutdown);
      };
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

    const registration = createReleaseRuntimeRegistration({
      appEnv: config.appEnv,
      deploymentRevision: runtimeConfig.deploymentRevision,
      whatsappSessionKey: runtimeConfig.sessionKey,
      instanceId: randomUUID(),
    });

    if (registration === null) {
      const shutdown = new AbortController();
      const requestShutdown = (): void => shutdown.abort();
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
      removeSignalHandlers = () => {
        process.removeListener("SIGINT", requestShutdown);
        process.removeListener("SIGTERM", requestShutdown);
      };

      logger.log("INFO", "runtime.ready", {
        appEnv: config.appEnv,
        mode: adminApi === null ? "whatsapp" : "whatsapp+admin-api",
      });
      await supervisor.run(shutdown.signal);
    } else {
      const health = new ReleaseRuntimeHealth(new PostgresRuntimeHealthRepository(pool), {
        registration,
        heartbeatMs: runtimeConfig.healthHeartbeatMs,
        onError: (error) => {
          logger.log("ERROR", "runtime.health.write_failed", { errorKind: errorKind(error) });
        },
      });
      const termination = new RuntimeTerminationController();
      const releaseProcess = new ReleaseRuntimeProcess(health, termination);
      const runtime = createOperationalWhatsAppRuntime({
        pool,
        auth,
        logger,
        onSessionInvalidated: releaseProcess.onSessionInvalidated,
        onProviderConnectionState: releaseProcess.onProviderConnectionState,
      });
      const supervisor = new WhatsAppRuntimeSupervisor(runtime, {
        pollIntervalMs: runtimeConfig.outboxPollMs,
        logger,
      });
      const onSigint = (): void => releaseProcess.onHostSignal("SIGINT");
      const onSigterm = (): void => releaseProcess.onHostSignal("SIGTERM");

      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      removeSignalHandlers = () => {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
      };

      logger.log("INFO", "runtime.ready", {
        appEnv: config.appEnv,
        mode: adminApi === null ? "whatsapp-release" : "whatsapp-release+admin-api",
        deploymentRevision: runtimeConfig.deploymentRevision,
      });
      await releaseProcess.run(supervisor);
    }
  }
} finally {
  removeSignalHandlers();
  await adminApi?.close();
  await auth?.close();
  await closeDatabasePool(pool);
}
