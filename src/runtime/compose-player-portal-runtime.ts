import type { Pool } from "pg";
import { registerPhase12DBatchAdminOperations } from "../modules/admin/batch-definitions.js";
import { AdminBatchService } from "../modules/admin/batch-service.js";
import { registerPhase12CBattleAdminOperations } from "../modules/admin/battle-definitions.js";
import { AdminBattleOperationService } from "../modules/admin/battle-service.js";
import { registerPhase12CompensationOperation } from "../modules/admin/compensation-definitions.js";
import { AdminCompensationService } from "../modules/admin/compensation-service.js";
import { createPhase12AdminOperationRegistry } from "../modules/admin/definitions.js";
import { registerPhase12CDomainAdminOperations } from "../modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../modules/admin/domain-service.js";
import { registerPhase12CEncounterAdminOperations } from "../modules/admin/encounter-definitions.js";
import { AdminEncounterOperationService } from "../modules/admin/encounter-service.js";
import { Player360Service } from "../modules/admin/player360-service.js";
import { AdminRewardCatalogService } from "../modules/admin/reward-catalog-service.js";
import { AdminService } from "../modules/admin/service.js";
import { BattleAdminOwnerService } from "../modules/battle/admin-service.js";
import { EconomyService } from "../modules/economy/service.js";
import { EncounterAdminOwnerService } from "../modules/encounter/admin-service.js";
import { PlayerRegistrationService } from "../modules/player/registration-service.js";
import { PokemonAdminService } from "../modules/pokemon/admin-service.js";
import { PlayerStarterService } from "../modules/player/starter-service.js";
import { PlayerPortalHttpHandler } from "../modules/player-portal/http-handler.js";
import { HubLoginTicketService } from "../modules/player-portal/login-ticket-service.js";
import { PlayerPortalMoveChoiceService } from "../modules/player-portal/move-choice-service.js";
import { PlayerPortalProfileCustomizationService } from "../modules/player-portal/profile-customization-service.js";
import { PlayerPortalReadService } from "../modules/player-portal/read-service.js";
import { PlayerPortalRosterService } from "../modules/player-portal/roster-service.js";
import { HubSessionTokenService } from "../modules/player-portal/session-token-service.js";
import { ProgressionService } from "../modules/progression/service.js";
import { WorldService } from "../modules/world/service.js";
import { PokemonPcStorageService } from "../modules/world-services/pc-storage-service.js";
import { SystemClock } from "../platform/clock/index.js";
import { PostgresAdminBatchRepository } from "../platform/admin/postgres-admin-batch-repository.js";
import { PostgresAdminCompensationCompletion } from "../platform/admin/postgres-admin-compensation-completion.js";
import { PostgresAdminOperationCompletion } from "../platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../platform/admin/postgres-admin-repository.js";
import { PostgresAdminRewardCatalogRepository } from "../platform/admin/postgres-admin-reward-catalog-repository.js";
import { PostgresAdminWhatsAppIdentityResolver } from "../platform/admin/postgres-admin-whatsapp-identity-resolver.js";
import { PostgresBattleAdminRepository } from "../platform/battle/postgres-battle-admin-repository.js";
import { PostgresBattleCancellation } from "../platform/battle/postgres-battle-cancellation.js";
import { PostgresPlayer360Repository } from "../platform/admin/postgres-player360-repository.js";
import { PostgresEconomyRepository } from "../platform/economy/postgres-economy-repository.js";
import { PostgresPokemonAdminRepository } from "../platform/pokemon/postgres-pokemon-admin-repository.js";
import { PostgresPokemonEffectAdminRepository } from "../platform/pokemon/postgres-pokemon-effect-admin-repository.js";
import { PostgresPokemonLifecycleAdminRepository } from "../platform/pokemon/postgres-pokemon-lifecycle-admin-repository.js";
import { PostgresEncounterAdminRepository } from "../platform/encounter/postgres-encounter-admin-repository.js";
import { PostgresOperationalUxReadModel } from "../platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerOnboardingRepository } from "../platform/player/postgres-player-onboarding-repository.js";
import { PostgresHubLoginTicketStore } from "../platform/player-portal/postgres-hub-login-ticket-store.js";
import { PostgresPlayerPortalProfileCustomizationRepository } from "../platform/player-portal/postgres-player-portal-profile-customization-repository.js";
import { PostgresPlayerPortalReadRepository } from "../platform/player-portal/postgres-player-portal-read-repository.js";
import { PostgresProgressionRepository } from "../platform/progression/postgres-progression-repository.js";
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
  const customizationRepository = new PostgresPlayerPortalProfileCustomizationRepository(
    options.pool,
  );
  const player = new PlayerPortalReadService({
    players,
    profiles,
    world,
    repository: readRepository,
    customization: customizationRepository,
    presentation,
  });
  const roster = new PlayerPortalRosterService({
    players,
    profiles,
    storage: pcStorage,
  });
  const progression = new ProgressionService(new PostgresProgressionRepository(options.pool));
  const moveChoices = new PlayerPortalMoveChoiceService({
    players,
    profiles,
    reads: presentation,
    progression,
  });
  const customization = new PlayerPortalProfileCustomizationService({
    players,
    profiles,
    repository: customizationRepository,
  });
  const tickets = new HubLoginTicketService(new PostgresHubLoginTicketStore(options.pool));
  const sessions = new HubSessionTokenService({ signingKey: options.sessionSigningKey });
  const admin = new PostgresAdminWhatsAppIdentityResolver(options.pool);
  const adminRepository = new PostgresAdminRepository(options.pool);
  const adminCompletion = new PostgresAdminOperationCompletion(options.pool);
  const economy = new EconomyService(new PostgresEconomyRepository(options.pool));
  const pokemonAdmin = new PokemonAdminService(
    new PostgresPokemonAdminRepository(options.pool),
    new PostgresPokemonEffectAdminRepository(options.pool),
    new PostgresPokemonLifecycleAdminRepository(options.pool),
  );
  const adminDomain = new AdminDomainOperationService(
    economy,
    progression,
    adminCompletion,
    pokemonAdmin,
  );
  const adminRegistry = registerPhase12CDomainAdminOperations(
    createPhase12AdminOperationRegistry(adminRepository),
    adminDomain,
  );
  const adminService = new AdminService(adminRegistry, adminRepository);

  const battleAdmin = new AdminBattleOperationService(
    adminService,
    new BattleAdminOwnerService(
      new PostgresBattleAdminRepository(options.pool),
      new PostgresBattleCancellation(options.pool),
    ),
    adminCompletion,
  );
  registerPhase12CBattleAdminOperations(adminRegistry, battleAdmin);

  const encounterAdmin = new AdminEncounterOperationService(
    adminService,
    new EncounterAdminOwnerService(new PostgresEncounterAdminRepository(options.pool)),
    adminCompletion,
  );
  registerPhase12CEncounterAdminOperations(adminRegistry, encounterAdmin);

  const compensation = new AdminCompensationService(
    adminRepository,
    economy,
    progression,
    new PostgresAdminCompensationCompletion(options.pool),
  );
  registerPhase12CompensationOperation(adminRegistry, compensation);

  const batch = new AdminBatchService(
    adminService,
    adminRegistry,
    adminRepository,
    new PostgresAdminBatchRepository(options.pool),
    adminCompletion,
  );
  registerPhase12DBatchAdminOperations(adminRegistry, batch);

  const adminPlayers = new Player360Service(
    adminService,
    new PostgresPlayer360Repository(options.pool),
  );
  const adminRewardCatalog = new AdminRewardCatalogService(
    adminService,
    new PostgresAdminRewardCatalogRepository(options.pool),
  );
  const portal = new PlayerPortalHttpHandler({
    tickets,
    sessions,
    player,
    roster,
    moveChoices,
    customization,
    admin,
    adminPlayers,
    adminRewardCatalog,
    adminMutations: adminService,
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
