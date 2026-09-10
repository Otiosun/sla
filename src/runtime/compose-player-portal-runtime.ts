import type { Pool } from "pg";
import { EncounterService } from "../modules/encounter/service.js";
import { PlayerPortalEncounterService } from "../modules/player-portal/encounter-service.js";
import { PlayerPortalHttpHandler } from "../modules/player-portal/http-handler.js";
import { HubLoginTicketService } from "../modules/player-portal/login-ticket-service.js";
import { PlayerPortalReadService } from "../modules/player-portal/read-service.js";
import { HubSessionTokenService } from "../modules/player-portal/session-token-service.js";
import { PlayerPortalWorldService } from "../modules/player-portal/world-service.js";
import { WorldService } from "../modules/world/service.js";
import { SystemClock } from "../platform/clock/index.js";
import { PostgresEncounterRepository } from "../platform/encounter/postgres-encounter-repository.js";
import { PostgresPlayerOnboardingRepository } from "../platform/player/postgres-player-onboarding-repository.js";
import { PostgresHubLoginTicketStore } from "../platform/player-portal/postgres-hub-login-ticket-store.js";
import { PostgresPlayerPortalCatalogResolver } from "../platform/player-portal/postgres-player-portal-catalog-resolver.js";
import { AesEncounterSeedProvider } from "../platform/rng/encrypted-seed-provider.js";
import { PostgresWorldRepository } from "../platform/world/postgres-world-repository.js";

interface PlayerPortalRuntimeOptions {
  readonly pool: Pool;
  readonly sessionSigningKey: Uint8Array;
  readonly encounterRngKey: Uint8Array;
  readonly encounterRngKeyVersion: number;
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
  const feature = { enabled: true, reason: null } as const;
  const playerRepository = new PostgresPlayerOnboardingRepository(options.pool);
  const catalog = new PostgresPlayerPortalCatalogResolver(options.pool);
  const player = new PlayerPortalReadService(playerRepository, catalog);
  const tickets = new HubLoginTicketService(new PostgresHubLoginTicketStore(options.pool));
  const sessions = new HubSessionTokenService({ signingKey: options.sessionSigningKey });
  const world = new PlayerPortalWorldService(
    playerRepository,
    new WorldService(new PostgresWorldRepository(options.pool), feature),
  );
  const encounter = new PlayerPortalEncounterService(
    playerRepository,
    new EncounterService(
      new PostgresEncounterRepository(options.pool),
      new AesEncounterSeedProvider(options.encounterRngKey, options.encounterRngKeyVersion),
      new SystemClock(),
      feature,
    ),
    catalog,
  );
  const portal = new PlayerPortalHttpHandler({ tickets, sessions, player, world, encounter });

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
