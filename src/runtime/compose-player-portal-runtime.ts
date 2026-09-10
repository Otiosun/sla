import type { Pool } from "pg";
import { PlayerPortalHttpHandler } from "../modules/player-portal/http-handler.js";
import { HubLoginTicketService } from "../modules/player-portal/login-ticket-service.js";
import { PlayerPortalReadService } from "../modules/player-portal/read-service.js";
import { PlayerPortalRosterService } from "../modules/player-portal/roster-service.js";
import { HubSessionTokenService } from "../modules/player-portal/session-token-service.js";
import { PostgresPlayerOnboardingRepository } from "../platform/player/postgres-player-onboarding-repository.js";
import { PostgresHubLoginTicketStore } from "../platform/player-portal/postgres-hub-login-ticket-store.js";
import { PostgresPlayerPortalCatalogResolver } from "../platform/player-portal/postgres-player-portal-catalog-resolver.js";

interface PlayerPortalRuntimeOptions {
  readonly pool: Pool;
  readonly sessionSigningKey: Uint8Array;
  readonly deploymentRevision: string | null;
}

interface PlayerPortalRequestHandler {
  handle(request: Request): Promise<Response>;
}

export interface PlayerPortalRuntime {
  readonly handler: PlayerPortalRequestHandler;
}

export function composePlayerPortalRuntime(
  options: PlayerPortalRuntimeOptions,
): PlayerPortalRuntime {
  const playerRepository = new PostgresPlayerOnboardingRepository(options.pool);
  const catalog = new PostgresPlayerPortalCatalogResolver(options.pool);
  const player = new PlayerPortalReadService(playerRepository, catalog);
  const roster = new PlayerPortalRosterService(playerRepository);
  const tickets = new HubLoginTicketService(new PostgresHubLoginTicketStore(options.pool));
  const sessions = new HubSessionTokenService({ signingKey: options.sessionSigningKey });
  const portal = new PlayerPortalHttpHandler({ tickets, sessions, player, roster });

  return {
    handler: {
      handle: async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          return new Response(
            JSON.stringify({
              status: "ok",
              service: "pokemon-player-portal-api",
              revision: options.deploymentRevision,
            }),
            {
              status: 200,
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json; charset=utf-8",
              },
            },
          );
        }

        return portal.handle(request);
      },
    },
  };
}
