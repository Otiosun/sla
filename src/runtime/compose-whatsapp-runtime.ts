import type { Pool } from "pg";
import {
  BaileysWhatsAppAdapter,
  type BaileysAuthBinding,
} from "../adapters/whatsapp/baileys-whatsapp-adapter.js";
import type { WhatsAppProviderConnectionState } from "../adapters/whatsapp/adapter.js";
import { WhatsAppMessagingRuntime } from "../adapters/whatsapp/runtime.js";
import { BattleOperationalReadService } from "../modules/battle/operational-read-service.js";
import { CommunityService } from "../modules/community/service.js";
import { RuntimeCommandPolicyGate } from "../modules/community/runtime-command-policy-gate.js";
import { EncounterOperationalReadService } from "../modules/encounter/operational-read-service.js";
import type { IncomingMessage } from "../modules/messaging/contracts.js";
import { withOperationalCommandAliases } from "../modules/messaging/operational-command-aliases.js";
import { createOperationalUxRoutes } from "../modules/messaging/operational-ux-handlers.js";
import { MessageRouter } from "../modules/messaging/router.js";
import { MessagingService, OutboxWorker } from "../modules/messaging/service.js";
import { PlayerRegistrationService } from "../modules/player/registration-service.js";
import { PlayerStarterService } from "../modules/player/starter-service.js";
import { RegistrationConversationResolver } from "../modules/registration/conversation-resolver.js";
import { RegistrationConversationSessions } from "../modules/registration/conversation-session.js";
import { RegistrationService } from "../modules/registration/service.js";
import { createRegistrationWhatsAppRoutes } from "../modules/registration/whatsapp-handlers.js";
import { WorldService } from "../modules/world/service.js";
import { PostgresBattleRepository } from "../platform/battle/postgres-battle-repository.js";
import { SystemClock } from "../platform/clock/index.js";
import { PostgresCommunityRepository } from "../platform/community/postgres-community-repository.js";
import { PostgresEncounterRepository } from "../platform/encounter/postgres-encounter-repository.js";
import type { StructuredLogger } from "../platform/logging/index.js";
import { PostgresMessagingRepository } from "../platform/messaging/postgres-messaging-repository.js";
import { PostgresOperationalUxReadModel } from "../platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerOnboardingRepository } from "../platform/player/postgres-player-onboarding-repository.js";
import { PostgresPlayerAccessRepository } from "../platform/registration/postgres-player-access-repository.js";
import { PostgresRegistrationRepository } from "../platform/registration/postgres-registration-repository.js";
import { PostgresRegistrationSetupLoader } from "../platform/registration/postgres-registration-setup-loader.js";
import { CryptoRandomSource } from "../platform/rng/index.js";
import { PostgresWorldRepository } from "../platform/world/postgres-world-repository.js";

export type WhatsAppSessionInvalidationReason = "PAIRING_REQUIRED" | "LOGGED_OUT";

export interface OperationalWhatsAppRuntimeOptions {
  readonly pool: Pool;
  readonly auth: BaileysAuthBinding;
  readonly logger: StructuredLogger;
  readonly onSessionInvalidated?: (reason: WhatsAppSessionInvalidationReason) => void;
  readonly onProviderConnectionState?: (
    state: WhatsAppProviderConnectionState,
  ) => Promise<void> | void;
}

export interface OperationalMessagingComposition {
  readonly router: MessageRouter;
  readonly admitFreeform: (message: IncomingMessage) => Promise<boolean>;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createOperationalMessagingComposition(pool: Pool): OperationalMessagingComposition {
  const playerRepository = new PostgresPlayerOnboardingRepository(pool);
  const playerRegistration = new PlayerRegistrationService(playerRepository);
  const starter = new PlayerStarterService(
    playerRepository,
    new SystemClock(),
    new CryptoRandomSource(),
  );
  const world = new WorldService(new PostgresWorldRepository(pool), {
    enabled: true,
    reason: null,
  });
  const encounter = new EncounterOperationalReadService(new PostgresEncounterRepository(pool));
  const battle = new BattleOperationalReadService(new PostgresBattleRepository(pool));
  const reads = new PostgresOperationalUxReadModel(pool);

  const community = new CommunityService(new PostgresCommunityRepository(pool));
  const registration = new RegistrationService(new PostgresRegistrationRepository(pool));
  const setup = new PostgresRegistrationSetupLoader(pool);
  const accessRepository = new PostgresPlayerAccessRepository(pool);
  const sessions = new RegistrationConversationSessions();
  const conversationResolver = new RegistrationConversationResolver({
    sessions,
    community,
    players: playerRegistration,
    setup,
  });
  const policyGate = new RuntimeCommandPolicyGate({
    community,
    players: playerRegistration,
    access: {
      load: async (playerId) => accessRepository.read(async (tx) => tx.load(playerId)),
    },
    admins: {
      capabilitiesFor: async () => [],
    },
  });

  const legacyRoutes = withOperationalCommandAliases(
    createOperationalUxRoutes({
      registration: playerRegistration,
      starter,
      world,
      encounter,
      battle,
      reads,
    }).filter((definition) => definition.command !== "registrar"),
  );
  const registrationRoutes = createRegistrationWhatsAppRoutes({
    sessions,
    players: playerRegistration,
    registration,
    setup,
  });
  const router = new MessageRouter(
    [...legacyRoutes, ...registrationRoutes],
    policyGate,
    conversationResolver,
  );

  return {
    router,
    admitFreeform: (message) => conversationResolver.admits(message),
  };
}

export function createOperationalWhatsAppRuntime(
  options: OperationalWhatsAppRuntimeOptions,
): WhatsAppMessagingRuntime {
  const composition = createOperationalMessagingComposition(options.pool);
  const messagingRepository = new PostgresMessagingRepository(options.pool);
  const messaging = new MessagingService(messagingRepository, composition.router, 30_000);

  const adapter = new BaileysWhatsAppAdapter({
    auth: options.auth,
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
    ...(options.onProviderConnectionState === undefined
      ? {}
      : { onConnectionState: options.onProviderConnectionState }),
    onProviderError: (error) => {
      options.logger.log("ERROR", "whatsapp.provider.error", { errorKind: errorKind(error) });
    },
  });

  const outboxWorker = new OutboxWorker(messagingRepository, [adapter], {
    batchSize: 50,
    staleAfterMs: 30_000,
    maxAttempts: 8,
    baseBackoffMs: 1_000,
    maxBackoffMs: 60_000,
  });

  return new WhatsAppMessagingRuntime(adapter, messaging, outboxWorker, {
    admitFreeform: composition.admitFreeform,
  });
}
