import type { PlayerId, CorrelationId } from "../../shared-kernel/ids.js";
import { parseEncounterId } from "../../shared-kernel/ids.js";
import type { Result } from "../../shared-kernel/result.js";
import type { CaptureAttemptResult } from "../capture/contracts.js";
import { ExpeditionIncidentalCaptureAction } from "./expedition-incidental-capture-action.js";
import type { IssuedIncidentalMenu } from "../../platform/exploration/postgres-incidental-menu-snapshots.js";

/** The menu ID must come from the server's quoted-message/ref resolver. */
export interface ServerMenuLookup {
  findForPlayer(playerId: PlayerId, menuId: string): Promise<Result<IssuedIncidentalMenu>>;
}

export interface SentMessageMenuResolver {
  resolveReply(input: {
    readonly playerId: PlayerId;
    readonly repliedTo: {
      readonly provider: string;
      readonly chatRef: string;
      readonly externalMessageId: string;
    };
  }): Promise<Result<IssuedIncidentalMenu>>;
}

/**
 * Future WhatsApp transport seam: bind a numeric answer to an immutable
 * server-issued menu. Caller is responsible for authenticating the sender and
 * resolving replyToExternalMessageId -> menuId. Never derive menuId or itemId
 * from a user-submitted message body.
 */
export class ExpeditionIncidentalMenuDispatcher {
  public constructor(
    private readonly menus: ServerMenuLookup,
    private readonly capture: ExpeditionIncidentalCaptureAction,
  ) {}

  /**
   * Use the authoritative WhatsApp reply-to reference rather than a menu ID
   * typed or embedded by the trainer. The sender must already be authenticated
   * as playerId by the caller's transport admission layer.
   */
  public async dispatchCaptureReply(input: {
    readonly playerId: PlayerId;
    readonly repliedTo: {
      readonly provider: string;
      readonly chatRef: string;
      readonly externalMessageId: string;
    };
    readonly resolver: SentMessageMenuResolver;
    readonly rawChoice: string;
    readonly inboxIdempotencyKey: string;
    readonly correlationId: CorrelationId;
    readonly causationId: string | null;
  }): Promise<Result<CaptureAttemptResult>> {
    const issued = await input.resolver.resolveReply({
      playerId: input.playerId,
      repliedTo: input.repliedTo,
    });
    if (!issued.ok) return issued;
    return this.captureFromIssued(issued.value, input);
  }

  private captureFromIssued(
    issued: IssuedIncidentalMenu,
    input: {
      readonly playerId: PlayerId;
      readonly rawChoice: string;
      readonly inboxIdempotencyKey: string;
      readonly correlationId: CorrelationId;
      readonly causationId: string | null;
    },
  ): Promise<Result<CaptureAttemptResult>> {
    const encounterId = parseEncounterId(issued.menu.encounterId);
    if (!encounterId.ok) return Promise.resolve(encounterId);
    return this.capture.execute({
      playerId: input.playerId,
      rawChoice: input.rawChoice,
      expectedEncounterId: encounterId.value,
      expectedEncounterRevision: issued.menu.encounterRevision,
      snapshot: issued,
      idempotencyKey: input.inboxIdempotencyKey,
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
  }

  public async dispatchCapture(input: {
    readonly playerId: PlayerId;
    readonly serverMenuId: string;
    readonly rawChoice: string;
    readonly inboxIdempotencyKey: string;
    readonly correlationId: CorrelationId;
    readonly causationId: string | null;
  }): Promise<Result<CaptureAttemptResult>> {
    const issued = await this.menus.findForPlayer(input.playerId, input.serverMenuId);
    if (!issued.ok) return issued;
    return this.captureFromIssued(issued.value, input);
  }
}
