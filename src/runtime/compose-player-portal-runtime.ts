import type { Pool } from "pg";
import { PlayerRegistrationService } from "../modules/player/registration-service.js";
import { PlayerStarterService } from "../modules/player/starter-service.js";
import { ProgressionService } from "../modules/progression/service.js";
import { PlayerPortalHttpHandler } from "../modules/player-portal/http-handler.js";
import { HubLoginTicketService } from "../modules/player-portal/login-ticket-service.js";
import { PlayerPortalMoveChoiceService } from "../modules/player-portal/move-choice-service.js";
import { PlayerPortalReadService } from "../modules/player-portal/read-service.js";
import { PlayerPortalRosterService } from "../modules/player-portal/roster-service.js";
import { HubSessionTokenService } from "../modules/player-portal/session-token-service.js";
import { WorldService } from "../modules/world/service.js";
import { PokemonPcStorageService } from "../modules/world-services/pc-storage-service.js";
import { SystemClock } from "../platform/clock/index.js";
import { PostgresOperationalUxReadModel } from "../platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerOnboardingRepository } from "../platform/player/postgres-player-onboarding-repository.js";
import { PostgresProgressionRepository } from "../platform/progression/postgres-progression-repository.js";
import { PostgresHubLoginTicketStore } from "../platform/player-portal/postgres-hub-login-ticket-store.js";
import { PostgresPlayerPortalReadRepository } from "../platform/player-portal/postgres-player-portal-read-repository.js";
import { CryptoRandomSource } from "../platform/rng/index.js";
import { PostgresWorldRepository } from "../platform/world/postgres-world-repository.js";
import { PostgresPokemonPcStorageRepository } from "../platform/world-services/postgres-pokemon-pc-storage-repository.js";

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
  const players = new PlayerRegistrationService(playerRepository);
  const profiles = new PlayerStarterService(
    playerRepository,
    new SystemClock(),
    new CryptoRandomSource(),
  );
  const world = new WorldService(new PostgresWorldRepository(options.pool), {
    enabled: true,
    reason: null,
  });
  const pcStorage = new PokemonPcStorageService(
    new PostgresPokemonPcStorageRepository(options.pool),
  );
  const presentation = new PostgresOperationalUxReadModel(options.pool);
  const readRepository = new PostgresPlayerPortalReadRepository(options.pool);
  const player = new PlayerPortalReadService({
    players,
    profiles,
    world,
    repository: readRepository,
    presentation,
  });
  const roster = new PlayerPortalRosterService({
    players,
    profiles,
    storage: pcStorage,
  });
  const moveChoices = new PlayerPortalMoveChoiceService({
    players,
    profiles,
    reads: presentation,
    progression: new ProgressionService(new PostgresProgressionRepository(options.pool)),
  });
  const tickets = new HubLoginTicketService(new PostgresHubLoginTicketStore(options.pool));
  const sessions = new HubSessionTokenService({ signingKey: options.sessionSigningKey });
  const portal = new PlayerPortalHttpHandler({
    tickets,
    sessions,
    player,
    roster,
    moveChoices,
  });

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
