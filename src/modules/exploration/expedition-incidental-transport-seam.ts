import type { PlayerId, CorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CaptureAttemptResult } from "../capture/contracts.js";
import {
  ExpeditionIncidentalMenuDispatcher,
  type SentMessageMenuResolver,
} from "./expedition-incidental-menu-dispatch.js";
import type {
  PostgresIncidentalMenuSnapshots,
} from "../../platform/exploration/postgres-incidental-menu-snapshots.js";
import type { ProviderMessageReference } from "../../platform/exploration/postgres-incidental-menu-reply-binding.js";

/**
 * Transport-facing SHADOW seam. It is deliberately NOT registered in Baileys,
 * and cannot determine the sender's identity from a WhatsApp body or quote.
 * The caller must supply a PlayerId authenticated by the existing admission
 * layer and provider/chat references obtained from the transport envelope.
 */
export interface IncidentalMenuSender {
  /**
   * Send the *exact* server-issued text. Prefer provider/outbox idempotency
   * keyed by menuId; the caller must separately handle uncertain send receipts.
   */
  send(input: {
    readonly provider: string;
    readonly chatRef: string;
    readonly text: string;
    readonly menuId: string;
  }): Promise<Result<ProviderMessageReference>>;
}

export interface IncidentalMenuDeliveryBinding extends SentMessageMenuResolver {
  bindDelivered(input: {
    readonly playerId: PlayerId;
    readonly menuId: string;
    readonly message: ProviderMessageReference;
  }): Promise<Result<void>>;
}

export type TrustedIncidentalMenuRequest = {
  readonly playerId: PlayerId;
  readonly outcomeId: string;
  /** These flags come from the trusted gameplay policy, never the player. */
  readonly canBattle: boolean;
  readonly canIgnore: boolean;
  readonly combiningCount: number;
  /** From the authenticated outbound transport, not user-provided text. */
  readonly provider: string;
  readonly chatRef: string;
};

export type TrustedIncidentalReply = {
  /** Identified by the existing WhatsApp admission/authentication layer. */
  readonly playerId: PlayerId;
  readonly provider: string;
  readonly chatRef: string;
  /** Quoted message ID from the provider envelope, not the reply body. */
  readonly quotedExternalMessageId: string;
  readonly rawChoice: string;
  /** Stable original inbound inbox key. Never regenerate it on retry. */
  readonly inboxIdempotencyKey: string;
  readonly correlationId: CorrelationId;
  readonly causationId: string | null;
};

const cleanReference = (value: string): boolean =>
  value.length > 0 && value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const cleanProvider = (value: string): boolean =>
  /^[a-z0-9_-]{1,30}$/u.test(value);

export class ExpeditionIncidentalTransportSeam {
  public constructor(
    private readonly snapshots: Pick<PostgresIncidentalMenuSnapshots, "issue">,
    private readonly bindings: IncidentalMenuDeliveryBinding,
    private readonly sender: IncidentalMenuSender,
    private readonly dispatcher: Pick<ExpeditionIncidentalMenuDispatcher, "dispatchCaptureReply">,
  ) {}

  /**
   * One issuance + one confirmed provider send + a durable reply binding.
   * The two external effects cannot be a PostgreSQL atomic transaction:
   * if the send succeeds but binding fails, fail CLOSED and surface the error.
   * Do not announce successful delivery nor send blindly again after a crash.
   */
  public async present(input: TrustedIncidentalMenuRequest): Promise<Result<{
    readonly menuId: string;
    readonly message: ProviderMessageReference;
    readonly text: string;
  }>> {
    if (!cleanProvider(input.provider) || !cleanReference(input.chatRef)) {
      return err(appError("VALIDATION_FAILED", "Invalid authenticated outbound context"));
    }
    const issued = await this.snapshots.issue({
      playerId: input.playerId,
      outcomeId: input.outcomeId,
      canBattle: input.canBattle,
      canIgnore: input.canIgnore,
      combiningCount: input.combiningCount,
    });
    if (!issued.ok) return issued;
    const delivered = await this.sender.send({
      provider: input.provider,
      chatRef: input.chatRef,
      text: issued.value.menu.text,
      menuId: issued.value.menuId,
    });
    if (!delivered.ok) return delivered;
    if (delivered.value.provider !== input.provider ||
        delivered.value.chatRef !== input.chatRef ||
        !cleanReference(delivered.value.externalMessageId)) {
      return err(appError("FLOW_BLOCKED", "Provider receipt does not match the sent chat"));
    }
    const linked = await this.bindings.bindDelivered({
      playerId: input.playerId,
      menuId: issued.value.menuId,
      message: delivered.value,
    });
    if (!linked.ok) return linked;
    return ok({
      menuId: issued.value.menuId,
      message: delivered.value,
      text: issued.value.menu.text,
    });
  }

  /**
   * Does not silently interpret '1' (PvE) or '0' (ignore) as capture.
   * The upcoming dispatcher must implement those actions independently.
   */
  public async captureQuotedReply(input: TrustedIncidentalReply): Promise<Result<CaptureAttemptResult>> {
    if (!cleanProvider(input.provider) || !cleanReference(input.chatRef) ||
        !cleanReference(input.quotedExternalMessageId) ||
        !/^[234]$/u.test(input.rawChoice) ||
        input.inboxIdempotencyKey.trim().length === 0 ||
        input.inboxIdempotencyKey.length > 200) {
      return err(appError("VALIDATION_FAILED", "Invalid authenticated incidental capture reply"));
    }
    return this.dispatcher.dispatchCaptureReply({
      playerId: input.playerId,
      repliedTo: {
        provider: input.provider,
        chatRef: input.chatRef,
        externalMessageId: input.quotedExternalMessageId,
      },
      resolver: this.bindings,
      rawChoice: input.rawChoice,
      inboxIdempotencyKey: input.inboxIdempotencyKey,
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
  }
}
