import type { PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import type { OutboxDeliveryPreparation } from "../../modules/messaging/ports.js";
import type { WorldServiceSessionService } from "../../modules/world-services/session-service.js";
import { parsePlayerId, type PlayerId } from "../../shared-kernel/ids.js";

interface WorldServicePromptWriter {
  setActivePrompt: WorldServiceSessionService["setActivePrompt"];
}

export interface WorldServicePromptDeliveryPreparationOptions {
  readonly sessions: WorldServicePromptWriter;
  readonly providerMessageIdFor: (message: PendingOutboxMessage) => string;
}

interface WorldServicePromptDeliveryAnchor {
  readonly playerId: PlayerId;
  readonly expectedRevision: bigint;
}

function parseAnchor(value: unknown): WorldServicePromptDeliveryAnchor | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid World Service prompt delivery anchor");
  }

  const rawPlayerId = "playerId" in value ? value.playerId : undefined;
  const rawExpectedRevision = "expectedRevision" in value ? value.expectedRevision : undefined;
  if (
    typeof rawPlayerId !== "string" ||
    typeof rawExpectedRevision !== "string" ||
    !/^\d+$/.test(rawExpectedRevision)
  ) {
    throw new Error("Invalid World Service prompt delivery anchor");
  }

  const playerId = parsePlayerId(rawPlayerId);
  if (!playerId.ok) throw new Error("Invalid World Service prompt delivery anchor");

  return {
    playerId: playerId.value,
    expectedRevision: BigInt(rawExpectedRevision),
  };
}

export class WorldServicePromptDeliveryPreparation implements OutboxDeliveryPreparation {
  public constructor(private readonly options: WorldServicePromptDeliveryPreparationOptions) {}

  public async prepare(message: PendingOutboxMessage): Promise<void> {
    if (message.channel !== "whatsapp") return;

    const anchor = parseAnchor(message.payload.worldServicePrompt);
    if (anchor === null) return;

    const providerExternalMessageId = this.options.providerMessageIdFor(message).trim();
    if (providerExternalMessageId.length === 0) {
      throw new Error("World Service prompt provider message id is required");
    }

    const persisted = await this.options.sessions.setActivePrompt({
      playerId: anchor.playerId,
      expectedRevision: anchor.expectedRevision,
      outboxIdempotencyKey: message.idempotencyKey,
      externalMessageId: providerExternalMessageId,
    });
    if (!persisted.ok) {
      throw new Error(`World Service prompt persistence failed: ${persisted.error.code}`);
    }
  }
}
