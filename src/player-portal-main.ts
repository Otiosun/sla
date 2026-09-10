import { SystemClock } from "./platform/clock/index.js";
import { loadConfig } from "./platform/config/env.js";
import { JsonLineStdoutSink, StructuredLogger } from "./platform/logging/index.js";
import { loadPlayerPortalRuntimeConfig } from "./runtime/player-portal-runtime-config.js";
import { startPlayerPortalProcess } from "./runtime/start-player-portal-process.js";

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : null;
}

const logger = new StructuredLogger(new SystemClock(), new JsonLineStdoutSink());

try {
  const appConfig = loadConfig();
  const runtimeConfig = loadPlayerPortalRuntimeConfig(appConfig);
  const runtime = await startPlayerPortalProcess({
    appConfig,
    runtimeConfig,
    onError: (error) => {
      logger.log("ERROR", "player_portal.request_failed", {
        errorKind: errorKind(error),
        databaseCode: databaseErrorCode(error),
      });
    },
  });
  let closing = false;

  const shutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (closing) return;
    closing = true;
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    try {
      await runtime.close();
      logger.log("INFO", "player_portal.stopped", { signal });
    } catch (error) {
      process.exitCode = 1;
      logger.log("ERROR", "player_portal.shutdown_failed", {
        signal,
        errorKind: errorKind(error),
      });
    }
  };

  const onSigint = (): void => {
    void shutdown("SIGINT");
  };
  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  logger.log("INFO", "player_portal.ready", {
    appEnv: appConfig.appEnv,
    port: runtime.port,
    deploymentRevision: runtimeConfig.deploymentRevision,
  });
} catch (error) {
  process.exitCode = 1;
  logger.log("ERROR", "player_portal.start_failed", { errorKind: errorKind(error) });
}
