import type { Pool } from "pg";
import { baileysOutboundMessageId } from "../adapters/whatsapp/baileys-whatsapp-adapter.js";
import { WhatsAppMessagingRuntime } from "../adapters/whatsapp/runtime.js";
import {
  SimulatedWhatsAppAdapter,
  type SimulatedWhatsAppAdapterOptions,
} from "../adapters/whatsapp/simulated-whatsapp-adapter.js";
import type { IncomingMessage } from "../modules/messaging/contracts.js";
import { MessagingService } from "../modules/messaging/service.js";
import type { WorldServiceMediaCatalog } from "../modules/world-services/whatsapp-handlers.js";
import { PostgresMessagingRepository } from "../platform/messaging/postgres-messaging-repository.js";
import type { PveBattleRuntimeConfig } from "./compose-pve-battle-runtime.js";
import {
  createOperationalMessagingComposition,
  createOperationalOutboxWorker,
  type OperationalMessagingComposition,
} from "./compose-whatsapp-runtime.js";
import type { EncounterRngRuntimeConfig } from "./encounter-rng-runtime-config.js";

export interface OperationalSimulatedWhatsAppRuntimeOptions {
  readonly pool: Pool;
  readonly encounterRngConfig?: EncounterRngRuntimeConfig;
  readonly pveBattleConfig?: PveBattleRuntimeConfig;
  readonly worldServiceMedia?: WorldServiceMediaCatalog;
  readonly hubPublicUrl?: string | null;
  readonly now?: SimulatedWhatsAppAdapterOptions["now"];
  readonly onProviderConnectionState?: SimulatedWhatsAppAdapterOptions["onConnectionState"];
  readonly onIncomingProcessingFailure?: (input: {
    readonly stage: "COMPLETE_INCOMING";
    readonly errorCode: string;
    readonly correlationId: string | null;
  }) => void;
}

export interface OperationalSimulatedWhatsAppRuntime {
  readonly runtime: WhatsAppMessagingRuntime;
  readonly adapter: SimulatedWhatsAppAdapter;
  readonly composition: OperationalMessagingComposition;
}

export function createOperationalSimulatedWhatsAppRuntime(
  options: OperationalSimulatedWhatsAppRuntimeOptions,
): OperationalSimulatedWhatsAppRuntime {
  const composition = createOperationalMessagingComposition(
    options.pool,
    options.encounterRngConfig ?? null,
    options.worldServiceMedia ?? null,
    options.pveBattleConfig ?? null,
    options.hubPublicUrl ?? null,
  );
  const messagingRepository = new PostgresMessagingRepository(options.pool);
  const messaging = new MessagingService(messagingRepository, composition.router, 30_000);
  const adapter = new SimulatedWhatsAppAdapter({
    providerMessageIdFor: baileysOutboundMessageId,
    onMembership: composition.onMembership,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onProviderConnectionState === undefined
      ? {}
      : { onConnectionState: options.onProviderConnectionState }),
  });
  const outboxWorker = createOperationalOutboxWorker(options.pool, messagingRepository, adapter);

  const runtime = new WhatsAppMessagingRuntime(adapter, messaging, outboxWorker, {
    admitCommand: composition.admitRuntimeCommand,
    admitFreeform: composition.admitRuntimeFreeform,
    beforeOutboxFlush: composition.runMaintenance,
    ...(options.onIncomingProcessingFailure === undefined
      ? {}
      : { onIncomingProcessingFailure: options.onIncomingProcessingFailure }),
  });

  return { runtime, adapter, composition };
}

export function simulatedWhatsAppMessage(input: {
  readonly externalMessageId: string;
  readonly senderRef: string;
  readonly chatRef: string;
  readonly occurredAt: string;
  readonly text: string | null;
  readonly mentions?: readonly string[];
  readonly replyToExternalMessageId?: string | null;
}): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: input.externalMessageId,
    senderRef: input.senderRef,
    chatRef: input.chatRef,
    occurredAt: input.occurredAt,
    text: input.text,
    ...(input.mentions === undefined ? {} : { mentions: [...input.mentions] }),
    mediaRefs: [],
    replyToExternalMessageId: input.replyToExternalMessageId ?? null,
  };
}
