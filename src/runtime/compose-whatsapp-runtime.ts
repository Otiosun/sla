import type { Pool } from "pg";
import type { WhatsAppProviderConnectionState } from "../adapters/whatsapp/adapter.js";
import {
  type BaileysAuthBinding,
  BaileysWhatsAppAdapter,
  baileysOutboundMessageId,
} from "../adapters/whatsapp/baileys-whatsapp-adapter.js";
import { WhatsAppMessagingRuntime } from "../adapters/whatsapp/runtime.js";
import { CommunityGroupAdminService } from "../modules/admin/community-group-service.js";
import { AdminOperationRegistry } from "../modules/admin/operation-registry.js";
import { registerReceptionAdminOperations } from "../modules/admin/reception-operation-definitions.js";
import { AdminService } from "../modules/admin/service.js";
import { createUatBootstrapRoutes, UatBootstrapService } from "../modules/admin/uat-bootstrap.js";
import { BattleOperationalReadService } from "../modules/battle/operational-read-service.js";
import {
  createPveBattleStartWhatsAppRoute,
  PveBattleStartService,
} from "../modules/battle/pve-battle-start.js";
import {
  createPveSceneConversationResolver,
  createPveSceneRoutes,
} from "../modules/battle/pve-scene-whatsapp.js";
import { ReceptionAwareConversationResolver } from "../modules/community/reception-conversation-resolver.js";
import {
  type ReceptionMembershipEvent,
  ReceptionMembershipService,
} from "../modules/community/reception-membership.js";
import { ReceptionService } from "../modules/community/reception-service.js";
import { RuntimeCommandPolicyGate } from "../modules/community/runtime-command-policy-gate.js";
import { CommunityService } from "../modules/community/service.js";
import {
  createWorldGroupSetupRoute,
  registerWorldGroupSetupOperation,
} from "../modules/community/world-group-setup.js";
import { EconomyService } from "../modules/economy/service.js";
import { EncounterOperationalReadService } from "../modules/encounter/operational-read-service.js";
import { EncounterService } from "../modules/encounter/service.js";
import { createSpawnWhatsAppRoute } from "../modules/encounter/spawn-whatsapp.js";
import type { IncomingMessage } from "../modules/messaging/contracts.js";
import { withOperationalCommandAliases } from "../modules/messaging/operational-command-aliases.js";
import { withOperationalWorldPolicy } from "../modules/messaging/operational-command-policy.js";
import { createOperationalUxRoutes } from "../modules/messaging/operational-ux-handlers.js";
import type {
  OutboundMessageAdapter,
  OutboxDeliveryPreparation,
} from "../modules/messaging/ports.js";
import { MessageRouter } from "../modules/messaging/router.js";
import { MessagingService, OutboxWorker } from "../modules/messaging/service.js";
import { PlayerRegistrationService } from "../modules/player/registration-service.js";
import { PlayerStarterService } from "../modules/player/starter-service.js";
import { PvpService } from "../modules/pvp/service.js";
import { createPvpWhatsAppRoutes } from "../modules/pvp/whatsapp-handlers.js";
import { AuditedRegistrationReviewService } from "../modules/registration/admin-review-service.js";
import { createRegistrationAdminWhatsAppRoutes } from "../modules/registration/admin-review-whatsapp.js";
import { RegistrationConversationResolver } from "../modules/registration/conversation-resolver.js";
import { PlayerProvisioningService } from "../modules/registration/provisioning-service.js";
import { PlayerProvisioningWorker } from "../modules/registration/provisioning-worker.js";
import { RegistrationReviewMentionResolver } from "../modules/registration/review-mentions.js";
import {
  withRegistrationReviewConversationMentions,
  withRegistrationReviewMentions,
} from "../modules/registration/review-notification-mentions.js";
import { RegistrationService } from "../modules/registration/service.js";
import { createRegistrationWhatsAppRoutesV2 } from "../modules/registration/whatsapp-handlers-v2.js";
import { WorldService } from "../modules/world/service.js";
import { WorldServiceConversationResolver } from "../modules/world-services/conversation-resolver.js";
import { FishingService } from "../modules/world-services/fishing-service.js";
import { PokemonCenterHealingService } from "../modules/world-services/healing-service.js";
import { PokemonPcStorageService } from "../modules/world-services/pc-storage-service.js";
import { WorldServiceSessionService } from "../modules/world-services/session-service.js";
import {
  createWorldServiceWhatsAppRoutes,
  type WorldServiceMediaCatalog,
} from "../modules/world-services/whatsapp-handlers.js";
import { PostgresAdminOperationCompletion } from "../platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../platform/admin/postgres-admin-repository.js";
import { PostgresAdminWhatsAppIdentityResolver } from "../platform/admin/postgres-admin-whatsapp-identity-resolver.js";
import { PostgresBattleParticipantControllerRepository } from "../platform/battle/postgres-battle-participant-controller-repository.js";
import { PostgresBattleRepository } from "../platform/battle/postgres-battle-repository.js";
import { SystemClock } from "../platform/clock/index.js";
import { PostgresCommunityRepository } from "../platform/community/postgres-community-repository.js";
import { PostgresReceptionPresenceRepository } from "../platform/community/postgres-reception-presence-repository.js";
import { PostgresWorldGroupSetup } from "../platform/community/postgres-world-group-setup.js";
import { PostgresEconomyRepository } from "../platform/economy/postgres-economy-repository.js";
import { PostgresEncounterRepository } from "../platform/encounter/postgres-encounter-repository.js";
import type { StructuredLogger } from "../platform/logging/index.js";
import { PostgresMessagingRepository } from "../platform/messaging/postgres-messaging-repository.js";
import { PostgresOperationalUxReadModel } from "../platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerOnboardingRepository } from "../platform/player/postgres-player-onboarding-repository.js";
import { PostgresPvpChallengeRepository } from "../platform/pvp/postgres-pvp-challenge-repository.js";
import { PostgresPvpStartRepository } from "../platform/pvp/postgres-pvp-start-repository.js";
import { PostgresPlayerAccessRepository } from "../platform/registration/postgres-player-access-repository.js";
import { PostgresProvisioningCandidateSource } from "../platform/registration/postgres-provisioning-candidate-source.js";
import { PostgresReceptionActivationAnnouncement } from "../platform/registration/postgres-reception-activation-announcement.js";
import { PostgresRegistrationMessageRefRepository } from "../platform/registration/postgres-registration-message-ref-repository.js";
import { PostgresRegistrationReplyIntentVerifier } from "../platform/registration/postgres-registration-reply-intent-verifier.js";
import { PostgresRegistrationRepository } from "../platform/registration/postgres-registration-repository.js";
import { PostgresRegistrationSetupLoader } from "../platform/registration/postgres-registration-setup-loader.js";
import { RegistrationReviewDeliveryPreparation } from "../platform/registration/registration-review-delivery-preparation.js";
import { AesEncounterSeedProvider } from "../platform/rng/encrypted-seed-provider.js";
import { CryptoRandomSource } from "../platform/rng/index.js";
import { PostgresWorldRepository } from "../platform/world/postgres-world-repository.js";
import { PostgresFishingAttemptRepository } from "../platform/world-services/postgres-fishing-attempt-repository.js";
import { PostgresMartSaleInventoryReader } from "../platform/world-services/postgres-mart-sale-inventory-reader.js";
import { PostgresPokemonCenterHealingRepository } from "../platform/world-services/postgres-pokemon-center-healing-repository.js";
import { PostgresPokemonPcStorageRepository } from "../platform/world-services/postgres-pokemon-pc-storage-repository.js";
import { PostgresWorldServiceSessionRepository } from "../platform/world-services/postgres-world-service-session-repository.js";
import { WorldServicePromptDeliveryPreparation } from "../platform/world-services/world-service-prompt-delivery-preparation.js";
import {
  createPveBattleRuntime,
  type PveBattleRuntimeConfig,
} from "./compose-pve-battle-runtime.js";
import type { EncounterRngRuntimeConfig } from "./encounter-rng-runtime-config.js";

export type WhatsAppSessionInvalidationReason = "PAIRING_REQUIRED" | "LOGGED_OUT";

export interface OperationalWhatsAppRuntimeOptions {
  readonly pool: Pool;
  readonly auth: BaileysAuthBinding;
  readonly logger: StructuredLogger;
  readonly encounterRngConfig?: EncounterRngRuntimeConfig;
  readonly pveBattleConfig?: PveBattleRuntimeConfig;
  readonly worldServiceMedia?: WorldServiceMediaCatalog;
  readonly onSessionInvalidated?: (reason: WhatsAppSessionInvalidationReason) => void;
  readonly onProviderConnectionState?: (
    state: WhatsAppProviderConnectionState,
  ) => Promise<void> | void;
}

export interface OperationalMessagingComposition {
  readonly pveBattle: ReturnType<typeof createPveBattleRuntime> | null;
  readonly onMembership: (event: ReceptionMembershipEvent) => Promise<void>;
  readonly router: MessageRouter;
  readonly admitCommand: (message: IncomingMessage) => boolean;
  readonly admitFreeform: (message: IncomingMessage) => Promise<boolean>;
  readonly runMaintenance: () => Promise<void>;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createOperationalMessagingComposition(
  pool: Pool,
  encounterRngConfig: EncounterRngRuntimeConfig | null = null,
  worldServiceMedia: WorldServiceMediaCatalog | null = null,
  pveBattleConfig: PveBattleRuntimeConfig | null = null,
): OperationalMessagingComposition {
  const pveBattle = pveBattleConfig === null ? null : createPveBattleRuntime(pool, pveBattleConfig);
  const pvp = (() => {
    if (pveBattleConfig === null) return null;
    const keyEntries = [...pveBattleConfig.encryptionKeys.entries()];
    if (keyEntries.length !== 1) {
      throw new Error("PVP runtime requires exactly one explicit RNG encryption key");
    }
    const keyEntry = keyEntries[0];
    if (keyEntry === undefined) throw new Error("PVP runtime RNG key was not found");
    const [keyVersion, key] = keyEntry;
    const challenges = new PostgresPvpChallengeRepository(pool);
    const service = new PvpService(
      challenges,
      new AesEncounterSeedProvider(key, keyVersion),
      new SystemClock(),
      { enabled: true, reason: null },
      {
        challengeTtlMs: pveBattleConfig.turnWindowTtlMs,
        turnWindowTtlMs: pveBattleConfig.turnWindowTtlMs,
      },
      new PostgresPvpStartRepository(pool, new AesEncounterSeedProvider(key, keyVersion)),
    );
    return {
      service,
      openChallengeIdForTarget: async (playerId: string) =>
        challenges.read(
          async (transaction) => (await transaction.openChallengeForTarget(playerId))?.id ?? null,
        ),
    };
  })();
  const playerRepository = new PostgresPlayerOnboardingRepository(pool);
  const playerRegistration = new PlayerRegistrationService(playerRepository);
  const clock = new SystemClock();
  const starter = new PlayerStarterService(playerRepository, clock, new CryptoRandomSource());
  const world = new WorldService(new PostgresWorldRepository(pool), {
    enabled: true,
    reason: null,
  });
  const encounterRepository = new PostgresEncounterRepository(pool);
  const encounter = new EncounterOperationalReadService(encounterRepository);
  const encounterWriter =
    encounterRngConfig === null
      ? undefined
      : new EncounterService(
          encounterRepository,
          new AesEncounterSeedProvider(
            encounterRngConfig.encryptionKey,
            encounterRngConfig.encryptionKeyVersion,
          ),
          clock,
          { enabled: true, reason: null },
        );
  const fishing =
    encounterWriter === undefined
      ? undefined
      : new FishingService(
          new PostgresFishingAttemptRepository(pool),
          encounterWriter,
          new CryptoRandomSource(),
        );
  const battle = new BattleOperationalReadService(new PostgresBattleRepository(pool));
  const reads = new PostgresOperationalUxReadModel(pool);
  const economy = new EconomyService(new PostgresEconomyRepository(pool));
  const martSaleInventory = new PostgresMartSaleInventoryReader(pool);
  const martEconomy = {
    purchaseQuantity: economy.purchaseQuantity.bind(economy),
    getWalletBalance: economy.getWalletBalance.bind(economy),
    sellQuantity: economy.sellQuantity.bind(economy),
    listSellableInventory: martSaleInventory.listSellableInventory.bind(martSaleInventory),
  };

  const community = new CommunityService(new PostgresCommunityRepository(pool));
  const registrationRepository = new PostgresRegistrationRepository(pool);
  const registration = new RegistrationService(registrationRepository);
  const setup = new PostgresRegistrationSetupLoader(pool);
  const accessRepository = new PostgresPlayerAccessRepository(pool);
  const receptionPresence = new PostgresReceptionPresenceRepository(pool);
  const messageRefs = new PostgresRegistrationMessageRefRepository(pool);
  const adminIdentity = new PostgresAdminWhatsAppIdentityResolver(pool);
  const communityGroupAdmin = new CommunityGroupAdminService({
    community,
    completion: new PostgresAdminOperationCompletion(pool),
  });
  const adminRegistry = registerReceptionAdminOperations(new AdminOperationRegistry(), {
    communityGroup: communityGroupAdmin,
  });
  registerWorldGroupSetupOperation(adminRegistry);
  const adminService = new AdminService(adminRegistry, new PostgresAdminRepository(pool));
  const auditedRegistrationReview = new AuditedRegistrationReviewService({
    admin: adminService,
    registration,
    completion: new PostgresAdminOperationCompletion(pool),
  });
  const provisioning = new PlayerProvisioningService(
    registrationRepository,
    accessRepository,
    playerRegistration,
    starter,
    world,
    new PostgresReceptionActivationAnnouncement(pool),
  );
  const provisioningWorker = new PlayerProvisioningWorker(
    new PostgresProvisioningCandidateSource(pool),
    provisioning,
  );
  const reviewMentions = new RegistrationReviewMentionResolver({
    community,
    admins: adminIdentity,
  });
  const registrationConversationResolver = withRegistrationReviewConversationMentions(
    new RegistrationConversationResolver({
      registration,
      community,
      players: playerRegistration,
      setup,
      replyIntent: new PostgresRegistrationReplyIntentVerifier(pool),
    }),
    reviewMentions,
  );
  const reception = new ReceptionService({
    community,
    players: playerRegistration,
    registration,
    access: {
      load: async (playerId) => accessRepository.read(async (tx) => tx.load(playerId)),
    },
    presence: receptionPresence,
  });
  const receptionConversationResolver = new ReceptionAwareConversationResolver({
    registration: registrationConversationResolver,
    reception,
  });
  const receptionMembership = new ReceptionMembershipService({
    community,
    players: playerRegistration,
    reception,
    presence: receptionPresence,
  });
  const worldServiceSessions = new WorldServiceSessionService(
    new PostgresWorldServiceSessionRepository(pool),
    clock,
  );
  const pokemonCenterHealing = new PokemonCenterHealingService(
    new PostgresPokemonCenterHealingRepository(pool),
  );
  const pokemonPcStorage = new PokemonPcStorageService(
    new PostgresPokemonPcStorageRepository(pool),
  );
  const worldServiceConversationResolver = new WorldServiceConversationResolver({
    community,
    players: playerRegistration,
    world,
    sessions: worldServiceSessions,
    replyIntent: new PostgresRegistrationReplyIntentVerifier(pool),
    economy: martEconomy,
    pcStorage: pokemonPcStorage,
  });
  const conversationResolver = {
    resolve: async (context: Parameters<typeof receptionConversationResolver.resolve>[0]) => {
      if (pveScene !== null) {
        const sceneResult = await pveScene.resolve(context);
        if (!sceneResult.ok || sceneResult.value !== null) return sceneResult;
      }
      const receptionResult = await receptionConversationResolver.resolve(context);
      if (!receptionResult.ok || receptionResult.value !== null) return receptionResult;
      return worldServiceConversationResolver.resolve(context);
    },
  };
  const pveScene =
    pveBattle === null
      ? null
      : createPveSceneConversationResolver({
          players: playerRegistration,
          activeBattleId: reads.activeBattleId.bind(reads),
          battle: pveBattle.battle,
          controllers: new PostgresBattleParticipantControllerRepository(pool),
          admins: adminIdentity,
        });
  const pveBattleStart =
    encounterWriter === undefined || pveBattle === null
      ? null
      : new PveBattleStartService(encounterWriter, pveBattle.battle);

  const policyGate = new RuntimeCommandPolicyGate({
    community,
    players: playerRegistration,
    access: {
      load: async (playerId) => accessRepository.read(async (tx) => tx.load(playerId)),
    },
    admins: adminIdentity,
  });

  const legacyRoutes = withOperationalCommandAliases(
    withOperationalWorldPolicy(
      createOperationalUxRoutes({
        registration: playerRegistration,
        starter,
        world,
        encounter,
        battle,
        reads,
        ...(worldServiceMedia === null ? {} : { worldMedia: worldServiceMedia }),
      }).filter(
        (definition) =>
          !["registrar", "regioes", "regiao", "starters", "starter", "concluir"].includes(
            definition.command,
          ) &&
          (pveBattle === null || definition.command !== "batalha"),
      ),
    ),
  );
  const worldServiceRoutes = createWorldServiceWhatsAppRoutes({
    players: playerRegistration,
    world,
    sessions: worldServiceSessions,
    healing: pokemonCenterHealing,
    economy: martSaleInventory,
    pcStorage: pokemonPcStorage,
    ...(fishing === undefined ? {} : { fishing }),
    fishingSpecies: {
      speciesDisplayName: reads.speciesDisplayName.bind(reads),
    },
    ...(worldServiceMedia === null ? {} : { media: worldServiceMedia }),
  });
  const registrationRoutes = withRegistrationReviewMentions(
    createRegistrationWhatsAppRoutesV2({
      players: playerRegistration,
      registration,
      setup,
    }).map((definition) =>
      definition.command === "registrar"
        ? { ...definition, rateLimitClass: "SENSITIVE" as const }
        : definition,
    ),
    reviewMentions,
  );
  const registrationAdminRoutes = createRegistrationAdminWhatsAppRoutes({
    messageRefs,
    admins: adminIdentity,
    registration: auditedRegistrationReview,
    setup,
  });
  const uatBootstrapRoutes = createUatBootstrapRoutes({
    admins: adminIdentity,
    service: new UatBootstrapService(pool, playerRegistration, starter, world),
  });
  const router = new MessageRouter(
    [
      ...legacyRoutes,
      ...worldServiceRoutes,
      ...registrationRoutes,
      ...registrationAdminRoutes,
      ...(pveBattle === null
        ? []
        : createPveSceneRoutes({
            players: playerRegistration,
            activeBattleId: reads.activeBattleId.bind(reads),
            battle: pveBattle.battle,
            controllers: new PostgresBattleParticipantControllerRepository(pool),
            admins: adminIdentity,
          })),
      ...(pvp === null
        ? []
        : createPvpWhatsAppRoutes({
            players: playerRegistration,
            pvp: pvp.service,
            openChallengeIdForTarget: pvp.openChallengeIdForTarget,
          })),
      ...(pveBattleStart === null
        ? []
        : [
            createPveBattleStartWhatsAppRoute({
              players: playerRegistration,
              encounters: encounter,
              start: pveBattleStart,
            }),
          ]),
      ...(encounterWriter === undefined
        ? []
        : [createSpawnWhatsAppRoute({ players: playerRegistration, encounters: encounterWriter })]),
      createWorldGroupSetupRoute({
        admins: adminIdentity,
        admin: adminService,
        setup: new PostgresWorldGroupSetup(pool),
      }),
      ...uatBootstrapRoutes,
    ],
    policyGate,
    conversationResolver,
  );

  return {
    pveBattle,
    router,
    onMembership: (event) => receptionMembership.handle(event),
    admitCommand: (message) => router.admitsCommand(message),
    admitFreeform: async (message) =>
      (await registrationConversationResolver.admits(message)) ||
      worldServiceConversationResolver.admits(message),
    runMaintenance: async () => {
      await provisioningWorker.runOnce();
      await pveBattle?.runMaintenance();
    },
  };
}

export function createOperationalOutboxWorker(
  pool: Pool,
  messagingRepository: PostgresMessagingRepository,
  adapter: OutboundMessageAdapter,
): OutboxWorker {
  const registrationReviewPreparation = new RegistrationReviewDeliveryPreparation({
    provider: "baileys",
    messageRefs: new PostgresRegistrationMessageRefRepository(pool),
    providerMessageIdFor: baileysOutboundMessageId,
  });
  const worldServicePromptPreparation = new WorldServicePromptDeliveryPreparation({
    sessions: new WorldServiceSessionService(
      new PostgresWorldServiceSessionRepository(pool),
      new SystemClock(),
    ),
    providerMessageIdFor: baileysOutboundMessageId,
  });
  const deliveryPreparation: OutboxDeliveryPreparation = {
    prepare: async (message) => {
      await registrationReviewPreparation.prepare(message);
      await worldServicePromptPreparation.prepare(message);
    },
  };

  return new OutboxWorker(
    messagingRepository,
    [adapter],
    {
      batchSize: 50,
      staleAfterMs: 30_000,
      maxAttempts: 8,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
    },
    deliveryPreparation,
  );
}

export function createOperationalWhatsAppRuntime(
  options: OperationalWhatsAppRuntimeOptions,
): WhatsAppMessagingRuntime {
  const composition = createOperationalMessagingComposition(
    options.pool,
    options.encounterRngConfig ?? null,
    options.worldServiceMedia ?? null,
    options.pveBattleConfig ?? null,
  );
  const messagingRepository = new PostgresMessagingRepository(options.pool);
  const messaging = new MessagingService(messagingRepository, composition.router, 30_000);

  const adapter = new BaileysWhatsAppAdapter({
    auth: options.auth,
    onMembership: composition.onMembership,
    onConnectionState: async (state) => {
      options.logger.log(
        state === "CONNECTED" ? "INFO" : "WARN",
        state === "CONNECTED" ? "whatsapp.provider.connected" : "whatsapp.provider.disconnected",
      );
      await options.onProviderConnectionState?.(state);
    },
    onInboundUpsert: ({ acceptedCount, droppedCount, dropReason }) => {
      options.logger.log("INFO", "whatsapp.inbound.upsert", {
        acceptedCount,
        droppedCount,
        dropReason,
      });
    },
    onQr: () => {
      options.logger.log("ERROR", "whatsapp.auth.pairing_required", {
        action: "run-explicit-auth-bootstrap",
      });
      options.onSessionInvalidated?.("PAIRING_REQUIRED");
    },
    onLoggedOut: () => {
      options.logger.log("ERROR", "whatsapp.auth.logged_out");
      options.onSessionInvalidated?.("LOGGED_OUT");
    },
    onProviderError: (error) => {
      options.logger.log("ERROR", "whatsapp.provider.error", { errorKind: errorKind(error) });
    },
  });

  const outboxWorker = createOperationalOutboxWorker(options.pool, messagingRepository, adapter);

  return new WhatsAppMessagingRuntime(adapter, messaging, outboxWorker, {
    admitCommand: composition.admitCommand,
    admitFreeform: composition.admitFreeform,
    beforeOutboxFlush: composition.runMaintenance,
    onIncomingProcessingFailure: ({ stage, errorCode, correlationId }) => {
      options.logger.log("ERROR", "whatsapp.inbound.processing_failed", {
        stage,
        errorCode,
        correlationId,
      });
    },
  });
}
