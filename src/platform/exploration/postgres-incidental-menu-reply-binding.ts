import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  PostgresIncidentalMenuSnapshots,
  type IssuedIncidentalMenu,
} from "./postgres-incidental-menu-snapshots.js";

export interface ProviderMessageReference {
  /** Provider identity from the trusted transport, not user text. */
  readonly provider: string;
  readonly chatRef: string;
  readonly externalMessageId: string;
}
function validRef(ref: ProviderMessageReference): boolean {
  return (
    /^[a-z0-9_-]{1,30}$/u.test(ref.provider) &&
    ref.chatRef.length > 0 &&
    ref.chatRef.length <= 256 &&
    ref.externalMessageId.length > 0 &&
    ref.externalMessageId.length <= 256 &&
    ![...(ref.chatRef + ref.externalMessageId)].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

/**
 * Separate from provider delivery and authorization. Caller must:
 * 1. authenticate the WhatsApp sender -> PlayerId,
 * 2. issue a menu from authoritative PG state,
 * 3. bind the actual sent-message reference after provider confirmation,
 * 4. resolve replyToExternalMessageId in SAME provider/chat for that player.
 */
export class PostgresIncidentalMenuReplyBinding {
  public constructor(
    private readonly pool: Pool,
    private readonly snapshots: Pick<PostgresIncidentalMenuSnapshots, "findForPlayer">,
  ) {}

  public async bindDelivered(input: {
    readonly playerId: PlayerId;
    readonly menuId: string;
    readonly message: ProviderMessageReference;
  }): Promise<Result<void>> {
    if (!validRef(input.message)) {
      return err(appError("VALIDATION_FAILED", "Invalid delivered message reference"));
    }
    const owned = await this.snapshots.findForPlayer(input.playerId, input.menuId);
    if (!owned.ok) return owned;
    const written = await this.pool.query(
      `INSERT INTO solo_incidental_menu_deliveries
         (id,menu_id,player_id,provider,chat_ref,external_message_id)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(provider,chat_ref,external_message_id) DO NOTHING`,
      [
        randomUUID(),
        input.menuId,
        input.playerId,
        input.message.provider,
        input.message.chatRef,
        input.message.externalMessageId,
      ],
    );
    if (written.rowCount === 1) return ok(undefined);
    const existing = await this.pool.query<{ menu_id: string; player_id: string }>(
      `SELECT menu_id::text,player_id::text
        FROM solo_incidental_menu_deliveries
        WHERE provider=$1 AND chat_ref=$2 AND external_message_id=$3`,
      [input.message.provider, input.message.chatRef, input.message.externalMessageId],
    );
    return existing.rows[0]?.menu_id === input.menuId &&
      existing.rows[0]?.player_id === input.playerId
      ? ok(undefined)
      : err(appError("IDEMPOTENCY_KEY_INVALID", "This message is already bound to another menu"));
  }

  public async resolveReply(input: {
    readonly playerId: PlayerId;
    readonly repliedTo: ProviderMessageReference;
  }): Promise<Result<IssuedIncidentalMenu>> {
    if (!validRef(input.repliedTo)) {
      return err(appError("VALIDATION_FAILED", "Invalid reply-to message reference"));
    }
    const result = await this.pool.query<{ menu_id: string }>(
      `SELECT delivery.menu_id::text
        FROM solo_incidental_menu_deliveries delivery
        WHERE delivery.player_id=$1 AND delivery.provider=$2
          AND delivery.chat_ref=$3 AND delivery.external_message_id=$4`,
      [
        input.playerId,
        input.repliedTo.provider,
        input.repliedTo.chatRef,
        input.repliedTo.externalMessageId,
      ],
    );
    const id = result.rows[0]?.menu_id;
    return id === undefined
      ? err(appError("FLOW_BLOCKED", "No incidental menu matches this player's quoted message"))
      : this.snapshots.findForPlayer(input.playerId, id);
  }
}
