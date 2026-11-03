import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";

interface IgnoreRecoveryRow {
  readonly encounter_id: string;
  readonly outcome_id: string;
  readonly encounter_revision: string;
  readonly fingerprint: string;
  readonly elapsed_minutes: string;
  readonly effect_ref: string | null;
}

/**
 * Recover only a committed 10-minute IGNORE, never re-execute the FLED
 * mutation. The original claimed Inbox, payload fingerprint, private quote,
 * SENT ACTIONABLE Outbox, immutable choices and receipt must all match.
 * Deliberately not registered in operational WhatsApp.
 */
export class PostgresExpeditionIgnoreConfirmationRecovery {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async resolve(input: {
    readonly playerId: PlayerId;
    readonly context: MessageHandlerContext;
  }): Promise<Result<{ readonly encounterId: string; readonly elapsedMinutes: number } | null>> {
    const message = input.context.message;
    if (
      process.env.APP_ENV !== "test" ||
      process.env.NODE_ENV !== "test" ||
      process.env.WHATSAPP_ENABLED !== "false" ||
      message.provider !== "baileys" ||
      message.chatRef !== message.senderRef ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(message.senderRef) ||
      message.text?.trim() !== "0" ||
      !/^[a-f0-9]{32}$/iu.test(message.replyToExternalMessageId ?? "")
    ) {
      return ok(null);
    }
    const result = await this.pool.query<IgnoreRecoveryRow>(
      `SELECT menu.encounter_id::text AS encounter_id,
              menu.outcome_id::text AS outcome_id,
              menu.encounter_revision::text AS encounter_revision,
              receipt.fingerprint,
              receipt.result->'expedition'->>'elapsedMinutes' AS elapsed_minutes,
              receipt.result->>'effectRef' AS effect_ref
       FROM inbox_messages inbox
       JOIN player_identities identity
         ON identity.provider=inbox.provider
        AND identity.external_id=$5
        AND identity.player_id=$2
        AND identity.status='ACTIVE'
       JOIN solo_incidental_menu_deliveries delivery
         ON delivery.provider=inbox.provider
        AND delivery.player_id=identity.player_id
        AND delivery.chat_ref=$5
        AND upper(delivery.external_message_id)=
            upper(inbox.normalized_payload->>'replyToExternalMessageId')
       JOIN solo_incidental_menu_snapshots menu
         ON menu.id=delivery.menu_id
        AND menu.player_id=identity.player_id
        AND menu.panel->>'mode'='ACTIONABLE'
        AND menu.panel->'actions' ? 'IGNORE'
       JOIN solo_expedition_search_outcomes outcome
         ON outcome.id=menu.outcome_id
        AND outcome.player_id=menu.player_id
        AND outcome.encounter_id=menu.encounter_id
        AND outcome.kind='INCIDENTAL'
       JOIN encounters encounter
         ON encounter.id=menu.encounter_id
        AND encounter.player_id=menu.player_id
        AND encounter.status='FLED'
        AND encounter.revision=menu.encounter_revision+1
       JOIN solo_expedition_receipts receipt
         ON receipt.player_id=menu.player_id
        AND receipt.expedition_id=outcome.expedition_id
        AND receipt.idempotency_key=$3
        AND receipt.operation='ACTION_IGNORE_INCIDENTAL'
        AND receipt.result->>'effectRef'=menu.encounter_id::text
       JOIN outbox_messages outbound
         ON outbound.channel='whatsapp'
        AND outbound.message_type='TEXT'
        AND outbound.status='SENT'
        AND outbound.sent_at IS NOT NULL
        AND outbound.destination_ref=delivery.chat_ref
        AND upper(replace(outbound.id::text,'-',''))=upper(delivery.external_message_id)
        AND outbound.payload->>'text'=menu.panel->>'text'
        AND outbound.payload->'expeditionMenu'->>'menuId'=menu.id::text
        AND outbound.payload->'expeditionMenu'->>'mode'='ACTIONABLE'
        AND outbound.payload->'expeditionMenu'->'actions'=menu.panel->'actions'
        AND outbound.payload->'expeditionMenu'->'ballItemIds'=menu.ball_item_ids
        AND outbound.payload->'expeditionSearch'->>'playerId'=menu.player_id::text
        AND outbound.payload->'expeditionSearch'->>'outcomeId'=menu.outcome_id::text
        AND outbound.payload->'expeditionSearch'->>'encounterId'=menu.encounter_id::text
       WHERE inbox.id=$1 AND inbox.status='PROCESSING'
         AND inbox.provider='baileys'
         AND inbox.external_message_id=$6
         AND inbox.payload_hash=$4
         AND inbox.normalized_payload->>'senderRef'=$5
         AND inbox.normalized_payload->>'chatRef'=$5
         AND trim(inbox.normalized_payload->>'text')='0'
         AND upper(inbox.normalized_payload->>'replyToExternalMessageId')=upper($7)
       LIMIT 2`,
      [
        input.context.inboxMessageId,
        input.playerId,
        input.context.idempotencyKey,
        incomingMessageFingerprint(message),
        message.senderRef,
        message.externalMessageId,
        message.replyToExternalMessageId,
      ],
    );
    if (result.rows.length === 0) return ok(null);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row === undefined) {
      return err(appError("FLOW_BLOCKED", "Ignore confirmation recovery was ambiguous"));
    }
    const expectedFingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "ACTION_IGNORE_INCIDENTAL",
          row.outcome_id,
          row.encounter_id,
          row.encounter_revision,
          10,
        ]),
      )
      .digest("hex");
    const elapsedMinutes = Number(row.elapsed_minutes);
    if (
      !/^[a-f0-9-]{36}$/iu.test(row.encounter_id) ||
      !/^[0-9]+$/u.test(row.encounter_revision) ||
      row.fingerprint !== expectedFingerprint ||
      row.effect_ref !== row.encounter_id ||
      !Number.isSafeInteger(elapsedMinutes) ||
      elapsedMinutes < 10 ||
      elapsedMinutes > 720
    ) {
      return err(appError("FLOW_BLOCKED", "Ignore receipt does not match issued encounter"));
    }
    return ok({ encounterId: row.encounter_id, elapsedMinutes });
  }
}
