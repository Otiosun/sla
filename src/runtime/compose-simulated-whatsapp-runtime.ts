import type { Pool } from "pg";
import { baileysOutboundMessageId } from "../adapters/whatsapp/baileys-whatsapp-adapter.js";
import { WhatsAppMessagingRuntime } from "../adapters/whatsapp/runtime.js";
import {
  SimulatedWhatsAppAdapter,
  type SimulatedWhatsAppAdapterOptions,
} from "../adapters/whatsapp/simulated-whatsapp-adapter.js";
import { EncounterService } from "../modules/encounter/service.js";
import { ExpeditionSearchEngagementAfterSent } from "../modules/exploration/expedition-search-engagement-after-sent.js";
import { ExpeditionSearchPostSentHook } from "../modules/exploration/expedition-search-post-sent-hook.js";
import type { IncomingMessage } from "../modules/messaging/contracts.js";
import { MessagingService } from "../modules/messaging/service.js";
import type { WorldServiceMediaCatalog } from "../modules/world-services/whatsapp-handlers.js";
import { SystemClock } from "../platform/clock/index.js";
import { PostgresEncounterRepository } from "../platform/encounter/postgres-encounter-repository.js";
import { PostgresExpeditionOfflineActionableMenuIssuer } from "../platform/exploration/postgres-expedition-offline-actionable-menu-issuer.js";
import { PostgresExpeditionPostSentRecovery } from "../platform/exploration/postgres-expedition-post-sent-recovery.js";
import { PostgresExpeditionSearchSentProof } from "../platform/exploration/postgres-expedition-search-sent-proof.js";
import { PostgresMessagingRepository } from "../platform/messaging/postgres-messaging-repository.js";
import { AesEncounterSeedProvider } from "../platform/rng/encrypted-seed-provider.js";
import type { PveBattleRuntimeConfig } from "./compose-pve-battle-runtime.js";
import {
  createOperationalExpeditionDelivery,
  createOperationalMessagingComposition,
  createOperationalOutboxWorker,
  type OperationalMessagingComposition,
} from "./compose-whatsapp-runtime.js";
import type { EncounterRngRuntimeConfig } from "./encounter-rng-runtime-config.js";
import type { OperationalExpeditionPreview } from "./operational-expedition-preview.js";

export interface OperationalSimulatedWhatsAppRuntimeOptions {
  readonly pool: Pool;
  readonly operationalExpeditionPreview?: OperationalExpeditionPreview | null;
  readonly fishingDayTimeZone?: string | null;
  /** Isolated candidate 0081 only; never starts a live WhatsApp client. */
  readonly combatScenesEnabled?: boolean;
  readonly explorationReadMoreCombiningCount?: number;
  readonly encounterRngConfig?: EncounterRngRuntimeConfig;
  readonly pveBattleConfig?: PveBattleRuntimeConfig;
  readonly worldServiceMedia?: WorldServiceMediaCatalog;
  readonly hubPublicUrl?: string | null;
  /** Explicitly opt in ONLY when the disposable DB has the expedition draft schema. */
  readonly explorationPreviewTimeZone?: string | null;
  /** Test-only two-factor opt-in; never accepted by the live options. */
  readonly explorationStagingPreparationEnabled?: boolean;
  /** Isolated test-only outcome signing key; no production runtime equivalent. */
  readonly explorationStagingSearchSecret?: Uint8Array | null;
  /** DEVELOPMENT ONLY: real Capture/Ignore/PvE quoted replies on disposable DB. */
  readonly explorationOfflineChoicesEnabled?: boolean;
  /** Fourth opt-in: isolated PUBLISHED resource roll and canonical inventory grant. */
  readonly explorationStagingResourcesEnabled?: boolean;
  /** Requires all offline choices: trail Encounter must have real post-SENT capture/PvE. */
  readonly explorationStagingTrailEnabled?: boolean;
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
  /** Inspect failed staging post-SENT callbacks; never loses delivery errors. */
  readonly expeditionPostSentFailures: readonly {
    readonly outboxMessageId: string;
    readonly correlationId: string;
    readonly errorCode: string;
  }[];
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
    options.fishingDayTimeZone ?? null,
    options.operationalExpeditionPreview?.timeZone ?? options.explorationPreviewTimeZone ?? null,
    options.explorationStagingPreparationEnabled === true,
    options.explorationStagingSearchSecret ?? null,
    options.explorationOfflineChoicesEnabled === true,
    options.explorationStagingResourcesEnabled === true,
    options.explorationStagingTrailEnabled === true,
    options.combatScenesEnabled === true,
    options.explorationReadMoreCombiningCount ?? 0,
    options.operationalExpeditionPreview ?? null,
    options.operationalExpeditionPreview !== undefined,
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
  const expeditionPostSentFailures: Array<{
    readonly outboxMessageId: string;
    readonly correlationId: string;
    readonly errorCode: string;
  }> = [];
  const operationalDelivery =
    options.operationalExpeditionPreview === undefined
      ? undefined
      : createOperationalExpeditionDelivery(
          {
            pool: options.pool,
            expeditionPreview: options.operationalExpeditionPreview,
            ...(options.encounterRngConfig
              ? { encounterRngConfig: options.encounterRngConfig }
              : {}),
          },
          (failure) => expeditionPostSentFailures.push(failure),
          options.explorationReadMoreCombiningCount,
        );
  const afterSent =
    options.explorationOfflineChoicesEnabled === true && options.encounterRngConfig !== undefined
      ? new ExpeditionSearchPostSentHook(
          new ExpeditionSearchEngagementAfterSent(
            new PostgresExpeditionSearchSentProof(options.pool),
            new EncounterService(
              new PostgresEncounterRepository(options.pool),
              new AesEncounterSeedProvider(
                options.encounterRngConfig.encryptionKey,
                options.encounterRngConfig.encryptionKeyVersion,
              ),
              new SystemClock(),
              { enabled: true, reason: null },
            ),
          ),
          (failed) => expeditionPostSentFailures.push(failed),
          new PostgresExpeditionOfflineActionableMenuIssuer(
            options.pool,
            options.explorationReadMoreCombiningCount ?? 0,
          ),
        )
      : undefined;
  const recovery =
    afterSent === undefined
      ? undefined
      : new PostgresExpeditionPostSentRecovery(options.pool, afterSent);
  const outboxWorker = createOperationalOutboxWorker(
    options.pool,
    messagingRepository,
    adapter,
    operationalDelivery?.authorizedHook ?? afterSent,
    operationalDelivery?.permitsDelivery,
  );

  const runtime = new WhatsAppMessagingRuntime(adapter, messaging, outboxWorker, {
    admitCommand: composition.admitRuntimeCommand,
    admitFreeform: composition.admitRuntimeFreeform,
    normalizeCommandLikeFreeform: composition.normalizeRuntimeCommandLikeFreeform,
    beforeOutboxFlush: async () => {
      await composition.runMaintenance();
      await recovery?.runOnce();
      await operationalDelivery?.recovery?.runOnce();
    },
    ...(options.onIncomingProcessingFailure === undefined
      ? {}
      : { onIncomingProcessingFailure: options.onIncomingProcessingFailure }),
  });

  return { runtime, adapter, composition, expeditionPostSentFailures };
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
