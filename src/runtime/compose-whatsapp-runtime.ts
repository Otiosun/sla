import type { Pool } from "pg";
import { BaileysWhatsAppAdapter, type BaileysAuthBinding } from "../adapters/whatsapp/baileys-whatsapp-adapter.js";
import { WhatsAppMessagingRuntime } from "../adapters/whatsapp/runtime.js";
import { BattleOperationalReadService } from "../modules/battle/operational-read-service.js";
import { EncounterOperationalReadService } from "../modules/encounter/operational-read-service.js";
import { createOperationalUxRoutes } from "../modules/messaging/operational-ux-handlers.js";
import { MessageRouter } from "../modules/messaging/router.js";
import { MessagingService, OutboxWorker } from "../modules/messaging/service.js";
import { PlayerRegistrationService } from "../modules/player/registration-service.js";
import { PlayerStarterService } from "../modules/player/starter-service.js";
import { WorldService } from "../modules/world/service.js";
import { PostgresBattleRepository } from "../platform/battle/postgres-battle-repository.js";
import { SystemClock } from "../platform/clock/index.js";
import { PostgresEncounterRepository } from "../platform/encounter/postgres-encounter-repository.js";
import type { StructuredLogger } from "../platform/logging/index.js";
import { PostgresMessagingRepository } from "../platform/messaging/postgres-messaging-repository.js";
import { PostgresOperationalUxReadModel } from "../platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerOnboardingRepository } from "../platform/player/postgres-player-onboarding-repository.js";
import { CryptoRandomSource } from "../platform/rng/index.js";
import { PostgresWorldRepository } from "../platform/world/postgres-world-repository.js";

export interface OperationalWhatsAppRuntimeOptions {
  readonly pool: Pool;
  readonly auth: BaileysAuthBinding;
  readonly logger: StructuredLogger;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createOperationalWhatsAppRuntime(
  options: OperationalWhatsAppRuntimeOptions,
): WhatsAppMessagingRuntime {
  const playerRepository = new PostgresPlayerOnboardingRepository(options.pool);
  const registration = new PlayerRegistrationService(playerRepository);
  const starter = new PlayerStarterService(
    playerRepository,
    new SystemClock(),
    new CryptoRandomSource(),
  );
  const world = new WorldService(new PostgresWorldRepository(options.pool), {
    enabled: true,
    reason: null,
  });
  const encounter = new EncounterOperationalReadService(
    new PostgresEncounterRepository(options.pool),
  );
  const battle = new BattleOperationalReadService(new PostgresBattleRepository(options.pool));
  const reads = new PostgresOperationalUxReadModel(options.pool);
  const router = new MessageRouter(
    createOperationalUxRoutes({ registration, starter, world, encounter, battle, reads }),
  );
  const messagingRepository = new PostgresMessagingRepository(options.pool);
  const messaging = new MessagingService(messagingRepository, router, 30_000);

  const adapter = new BaileysWhatsAppAdapter({
    auth: options.auth,
    onQr: () => {
      options.logger.log("ERROR", "whatsapp.auth.pairing_required", {
        action: "run-explicit-auth-bootstrap",
      });
    },
    onLoggedOut: () => {
      options.logger.log("ERROR", "whatsapp.auth.logged_out");
    },
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

  return new WhatsAppMessagingRuntime(adapter, messaging, outboxWorker);
}
