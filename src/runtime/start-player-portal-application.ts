import type { Pool } from "pg";
import {
  startPlayerPortalHttpServer,
  type RunningPlayerPortalHttpServer,
} from "../adapters/http/player-portal-node-server.js";
import { composePlayerPortalRuntime } from "./compose-player-portal-runtime.js";
import type { PlayerPortalRuntimeConfig } from "./player-portal-runtime-config.js";

interface StartPlayerPortalApplicationOptions {
  readonly pool: Pool;
  readonly runtimeConfig: PlayerPortalRuntimeConfig;
}

export async function startPlayerPortalApplication(
  options: StartPlayerPortalApplicationOptions,
): Promise<RunningPlayerPortalHttpServer> {
  const runtime = composePlayerPortalRuntime({
    pool: options.pool,
    sessionSigningKey: options.runtimeConfig.sessionSigningKey,
    deploymentRevision: options.runtimeConfig.deploymentRevision,
  });

  return startPlayerPortalHttpServer({
    handler: runtime.handler,
    host: options.runtimeConfig.host,
    port: options.runtimeConfig.port,
  });
}
