import type { PendingOutboxMessage } from "../messaging/contracts.js";
import type { OutboxPostSentHook } from "../messaging/service.js";
import type { ExpeditionSearchEngagementAfterSent } from "./expedition-search-engagement-after-sent.js";
import { parsePlayerId } from "../../shared-kernel/ids.js";

/**
 * Opt-in staging hook for the REAL OutboxWorker's post-markOutboxSent seam.
 *
 * Metadata is read only from the server-owned durable Outbox payload, never
 * from an inbound WhatsApp message or quoted user text. The proof independently
 * verifies status=SENT, sent_at, private destination, player, outcome, encounter,
 * expedition area, and active published release before any encounter transition.
 *
 * Do not compose into the live Baileys runtime. No menu, battle, capture, grant
 * or new random encounter is emitted here.
 */
export class ExpeditionSearchPostSentHook implements OutboxPostSentHook {
  constructor(
    private readonly engagement: Pick<ExpeditionSearchEngagementAfterSent, "engageAfterSent">,
    private readonly reportFailure: (input: {
      readonly outboxMessageId: string;
      readonly correlationId: string;
      readonly errorCode: string;
    }) => void,
  ) {}

  async afterSent(
    message: Pick<
      PendingOutboxMessage,
      "id" | "channel" | "messageType" | "destinationRef" | "payload"
    >,
  ): Promise<void> {
    const anchor = message.payload.expeditionSearch;
    if (anchor === undefined) return; // Other Outbox messages are unaffected.
    if (
      message.channel !== "whatsapp" ||
      message.messageType !== "TEXT" ||
      anchor === null ||
      typeof anchor !== "object" ||
      Array.isArray(anchor) ||
      !("playerId" in anchor) ||
      !("outcomeId" in anchor) ||
      !("encounterId" in anchor) ||
      typeof anchor.playerId !== "string" ||
      typeof anchor.outcomeId !== "string" ||
      typeof anchor.encounterId !== "string"
    ) {
      throw new Error("EXPEDITION_POST_SENT_INVALID_ANCHOR");
    }

    const player = parsePlayerId(anchor.playerId);
    if (!player.ok) throw new Error("EXPEDITION_POST_SENT_INVALID_PLAYER");
    const result = await this.engagement.engageAfterSent({
      playerId: player.value,
      outcomeId: anchor.outcomeId,
      encounterId: anchor.encounterId,
      outboxMessageId: message.id,
      destinationRef: message.destinationRef,
    });
    if (!result.ok) throw new Error("EXPEDITION_POST_SENT_" + result.error.code);
  }

  onFailure(message: PendingOutboxMessage, error: unknown): void {
    this.reportFailure({
      outboxMessageId: message.id,
      correlationId: message.correlationId,
      // Do not leak the Outbox payload, player JID, snapshot, or full exception.
      errorCode:
        error instanceof Error && /^EXPEDITION_POST_SENT_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "EXPEDITION_POST_SENT_UNEXPECTED",
    });
  }
}
