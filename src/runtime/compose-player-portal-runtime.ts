import type { Pool } from "pg";
import { EntitlementService } from "../modules/entitlements/service.js";
import { PremiumSupportService } from "../modules/premium-support/service.js";
import { ManualPremiumDeliveryService } from "../modules/premium-orders/manual-delivery-service.js";
import { PremiumDeliveryCaseService } from "../modules/premium-orders/manual-delivery-case-service.js";
import { PremiumOrderService } from "../modules/premium-orders/service.js";
import { PostgresPremiumOrderRepository } from "../platform/premium-orders/postgres-premium-order-repository.js";
import { PostgresEntitlementRepository } from "../platform/entitlements/postgres-entitlement-repository.js";
import { AdminAuditService } from "../modules/admin/audit-service.js";
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
import { registerPlayerIdentityAdminOperations } from "../modules/admin/player-identity-definitions.js";
import { AdminPlayerIdentityService } from "../modules/admin/player-identity-service.js";
import { Player360Service } from "../modules/admin/player360-service.js";
import { AdminRewardCatalogService } from "../modules/admin/reward-catalog-service.js";
import { AdminService } from "../modules/admin/service.js";
import { AdminTeamService } from "../modules/admin/team-service.js";
import { BattleAdminOwnerService } from "../modules/battle/admin-service.js";
import { EconomyService } from "../modules/economy/service.js";
import { EncounterAdminOwnerService } from "../modules/encounter/admin-service.js";
import { PlayerRegistrationService } from "../modules/player/registration-service.js";
import { PlayerStarterService } from "../modules/player/starter-service.js";
import { AdminPlayerIdentityHttpHandler } from "../modules/player-portal/admin-player-identity-http-handler.js";
import { PlayerPortalHttpHandler } from "../modules/player-portal/http-handler.js";
import { HubLoginTicketService } from "../modules/player-portal/login-ticket-service.js";
import { PlayerPortalEvolutionService } from "../modules/player-portal/evolution-service.js";
import { PlayerPortalMoveChoiceService } from "../modules/player-portal/move-choice-service.js";
import { PlayerPortalProfileCustomizationService } from "../modules/player-portal/profile-customization-service.js";
import { PlayerPortalReadService } from "../modules/player-portal/read-service.js";
import { PlayerPortalRosterService } from "../modules/player-portal/roster-service.js";
import { HubSessionTokenService } from "../modules/player-portal/session-token-service.js";
import { PokemonAdminService } from "../modules/pokemon/admin-service.js";
import { ProgressionService } from "../modules/progression/service.js";
import { WorldService } from "../modules/world/service.js";
import { PokemonPcStorageService } from "../modules/world-services/pc-storage-service.js";
import { PostgresAdminAuditRepository } from "../platform/admin/postgres-admin-audit-repository.js";
import { PostgresAdminBatchRepository } from "../platform/admin/postgres-admin-batch-repository.js";
import { PostgresAdminCompensationCompletion } from "../platform/admin/postgres-admin-compensation-completion.js";
import { PostgresAdminOperationCompletion } from "../platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminPlayerIdentityOwner } from "../platform/admin/postgres-admin-player-identity-owner.js";
import { PostgresAdminRepository } from "../platform/admin/postgres-admin-repository.js";
import { PostgresAdminRewardCatalogRepository } from "../platform/admin/postgres-admin-reward-catalog-repository.js";
import { PostgresAdminTeamRepository } from "../platform/admin/postgres-admin-team-repository.js";
import { PostgresAdminWhatsAppIdentityResolver } from "../platform/admin/postgres-admin-whatsapp-identity-resolver.js";
import { PostgresPlayer360Repository } from "../platform/admin/postgres-player360-repository.js";
import { PostgresBattleAdminRepository } from "../platform/battle/postgres-battle-admin-repository.js";
import { PostgresBattleCancellation } from "../platform/battle/postgres-battle-cancellation.js";
import { SystemClock } from "../platform/clock/index.js";
import { PostgresEconomyRepository } from "../platform/economy/postgres-economy-repository.js";
import { PostgresEncounterAdminRepository } from "../platform/encounter/postgres-encounter-admin-repository.js";
import { PostgresOperationalUxReadModel } from "../platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerOnboardingRepository } from "../platform/player/postgres-player-onboarding-repository.js";
import { PostgresHubLoginTicketStore } from "../platform/player-portal/postgres-hub-login-ticket-store.js";
import { PostgresPlayerPortalProfileCustomizationRepository } from "../platform/player-portal/postgres-player-portal-profile-customization-repository.js";
import { PostgresPlayerPortalReadRepository } from "../platform/player-portal/postgres-player-portal-read-repository.js";
import { PostgresPokedexAdminSeenOwner } from "../platform/pokedex/postgres-pokedex-admin-seen-owner.js";
import { PostgresPokemonAdminRepository } from "../platform/pokemon/postgres-pokemon-admin-repository.js";
import { PostgresPokemonEffectAdminRepository } from "../platform/pokemon/postgres-pokemon-effect-admin-repository.js";
import { PostgresPokemonLifecycleAdminRepository } from "../platform/pokemon/postgres-pokemon-lifecycle-admin-repository.js";
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
    reads: presentation,
  });
  const progression = new ProgressionService(new PostgresProgressionRepository(options.pool));
  const moveChoices = new PlayerPortalMoveChoiceService({
    players,
    profiles,
    reads: presentation,
    progression,
  });
  const evolutions = new PlayerPortalEvolutionService({
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
    new PostgresPokedexAdminSeenOwner(options.pool),
  );
  const adminRegistry = registerPhase12CDomainAdminOperations(
    createPhase12AdminOperationRegistry(adminRepository),
    adminDomain,
  );
  registerPlayerIdentityAdminOperations(adminRegistry);
  const adminService = new AdminService(adminRegistry, adminRepository);
  const adminPlayerIdentity = new AdminPlayerIdentityService(
    adminService,
    new PostgresAdminPlayerIdentityOwner(options.pool),
  );
  const adminAudit = new AdminAuditService(
    adminService,
    new PostgresAdminAuditRepository(options.pool),
  );

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
  const adminTeam = new AdminTeamService(new PostgresAdminTeamRepository(options.pool));
  // The published catalog already defines 2XP and LUCK on the modern DB release.
  // This uses the same idempotent entitlement ledger, never payment mutation.
  const entitlements = new EntitlementService(new PostgresEntitlementRepository(options.pool));
  const premiumDelivery = new ManualPremiumDeliveryService(options.pool, entitlements);
  const adminPlayerIdentityHttp = new AdminPlayerIdentityHttpHandler({
    sessions,
    admin,
    adminTeam,
    identity: adminPlayerIdentity,
  });
  const portal = new PlayerPortalHttpHandler({
    tickets,
    sessions,
    player,
    roster,
    moveChoices,
    evolutions,
    customization,
    admin,
    adminPlayers,
    adminRewardCatalog,
    adminAudit,
    adminTeam,
    adminMutations: adminService,
    premiumDelivery,
    premiumSupport: new PremiumSupportService(options.pool),
    premiumCases: new PremiumDeliveryCaseService(options.pool),
    premiumRead: {
      orders: new PremiumOrderService(new PostgresPremiumOrderRepository(options.pool)),
      entitlements,
    },
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

        const adminIdentityResponse = await adminPlayerIdentityHttp.handle(request);
        if (adminIdentityResponse !== null) return adminIdentityResponse;
        return portal.handle(request);
      },
    },
  };
}
