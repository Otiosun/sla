import type { AppConfig } from "../platform/config/env.js";
import { closeDatabasePool, createDatabasePool } from "../platform/db/database.js";
import { assertDatabaseSchemaCurrent } from "../platform/db/migrations.js";
import type { PlayerPortalRuntimeConfig } from "./player-portal-runtime-config.js";
import { startPlayerPortalApplication } from "./start-player-portal-application.js";

interface StartPlayerPortalProcessOptions {
  readonly appConfig: AppConfig;
  readonly runtimeConfig: PlayerPortalRuntimeConfig;
  readonly onError?: (error: unknown) => void;
}

export interface RunningPlayerPortalProcess {
  readonly port: number;
  close(): Promise<void>;
}

export async function startPlayerPortalProcess(
  options: StartPlayerPortalProcessOptions,
): Promise<RunningPlayerPortalProcess> {
  const pool = createDatabasePool({
    connectionString: options.appConfig.databaseUrl,
    applicationName: "pokemon-player-portal-api",
    maxConnections: options.appConfig.databasePoolMax,
    connectionTimeoutMs: options.appConfig.databaseConnectTimeoutMs,
    idleTimeoutMs: options.appConfig.databaseIdleTimeoutMs,
    queryTimeoutMs: options.appConfig.databaseQueryTimeoutMs,
    statementTimeoutMs: options.appConfig.databaseStatementTimeoutMs,
    idleInTransactionSessionTimeoutMs: options.appConfig.databaseIdleInTransactionTimeoutMs,
  });

  try {
    await assertDatabaseSchemaCurrent(pool);
    const application = await startPlayerPortalApplication({
      pool,
      runtimeConfig: options.runtimeConfig,
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    let closePromise: Promise<void> | null = null;

    return {
      port: application.port,
      close: () => {
        closePromise ??= (async () => {
          try {
            await application.close();
          } finally {
            await closeDatabasePool(pool);
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await closeDatabasePool(pool);
    throw error;
  }
}
