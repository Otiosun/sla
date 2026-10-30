import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { parseCorrelationId, type PlayerId } from "../../shared-kernel/ids.js";
import { incomingMessageIdempotencyKey, type MessageHandlerContext } from "../messaging/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { CaptureAttemptResult } from "../capture/contracts.js";
import type { ExpeditionIncidentalTransportSeam } from "./expedition-incidental-transport-seam.js";

/**
 * NOT REGISTERED. Admission seam for future exploration conversation resolver.
 * The existing Baileys normalizer has already extracted sender/chat/quote
 * from the provider envelope. The original sender is resolved through the
 * canonical player-identity table, NOT from user-supplied text or menu JSON.
 * A separate real Community/Group capability gate must admit this group.
 */
export class ExpeditionIncidentalIncomingAdmission {
  public constructor(
    private readonly registration: Pick<PlayerRegistrationService, "resolvePlayer">,
    private readonly group: {
      admits(input: {
        readonly provider: string;
        readonly chatRef: string;
        readonly playerId: PlayerId;
      }): Promise<boolean>;
    },
    private readonly capture: Pick<ExpeditionIncidentalTransportSeam, "captureQuotedReply">,
  ) {}

  public async handle(
    context: MessageHandlerContext,
  ): Promise<Result<CaptureAttemptResult | null>> {
    const message = context.message;
    // Non-numeric and unquoted text belongs to other existing session routes.
    if (!/^[234]$/u.test(message.text ?? "") ||
        message.replyToExternalMessageId === null) {
      return ok(null);
    }
    // Only the exact inbox-assigned idempotency key and correlation ID may
    // reach CaptureService. A fabricated external key is never accepted.
    if (context.idempotencyKey !== incomingMessageIdempotencyKey(message)) {
      return err(appError("IDEMPOTENCY_KEY_INVALID", "Inbound message key is not authoritative"));
    }
    const correlation = parseCorrelationId(context.correlationId);
    if (!correlation.ok) return correlation;
    if (message.provider !== "baileys" ||
        message.senderRef.length === 0 || message.chatRef.length === 0 ||
        message.replyToExternalMessageId.length === 0) {
      return err(appError("FLOW_BLOCKED", "Invalid trusted incidental message envelope"));
    }
    const identity = await this.registration.resolvePlayer({
      provider: message.provider,
      externalId: message.senderRef,
    });
    if (!identity.ok || identity.value.state !== "COMPLETE") {
      return err(appError("PLAYER_INELIGIBLE", "Only an enrolled trainer can capture"));
    }
    const admitted = await this.group.admits({
      provider: message.provider,
      chatRef: message.chatRef,
      playerId: identity.value.playerId,
    });
    if (!admitted) return err(appError("FLOW_BLOCKED", "This group cannot use incidental capture"));
    return this.capture.captureQuotedReply({
      playerId: identity.value.playerId,
      provider: message.provider,
      chatRef: message.chatRef,
      quotedExternalMessageId: message.replyToExternalMessageId,
      rawChoice: message.text ?? "",
      inboxIdempotencyKey: context.idempotencyKey,
      correlationId: correlation.value,
      causationId: context.causationId,
    });
  }
}
