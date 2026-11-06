import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

interface ExistingBattleReceipt {
  readonly menu_id: string;
  readonly outcome_id: string;
  readonly encounter_id: string;
  readonly encounter_revision: string;
  readonly battle_id: string;
  readonly fingerprint: string;
}

/**
 * Read-only recovery of the ONE battle committed for this exact Inbox/menu.
 * A generic IN_BATTLE Encounter is never evidence of authorship: only the
 * immutable receipt written in the battle-start transaction is sufficient.
 * No WhatsApp runtime registration; isolated test mode only.
 */
export class PostgresExpeditionBattleConfirmationRecovery {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async resolve(input: {
    readonly playerId: PlayerId;
    readonly context: MessageHandlerContext;
  }): Promise<Result<{ readonly battleId: string } | null>> {
    const message = input.context.message;
    if (
      !expeditionOperationAllowed(input.playerId) ||
      message.provider !== "baileys" ||
      message.chatRef !== message.senderRef ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(message.senderRef) ||
      message.text?.trim() !== "1" ||
      !/^[a-f0-9]{32}$/iu.test(message.replyToExternalMessageId ?? "")
    ) {
      return ok(null);
    }
    const inboxFingerprint = incomingMessageFingerprint(message);
    const result = await this.pool.query<ExistingBattleReceipt>(
      `SELECT receipt.menu_id::text,receipt.outcome_id::text,
              receipt.encounter_id::text,receipt.encounter_revision::text,
              receipt.battle_id::text,receipt.fingerprint
       FROM solo_expedition_battle_receipts receipt
       JOIN inbox_messages inbox
         ON inbox.id=receipt.inbox_message_id
        AND inbox.provider='baileys'
        AND inbox.status='PROCESSING'
        AND inbox.payload_hash=$4
        AND inbox.normalized_payload->>'senderRef'=$5
        AND inbox.normalized_payload->>'chatRef'=$5
        AND trim(inbox.normalized_payload->>'text')='1'
        AND upper(inbox.normalized_payload->>'replyToExternalMessageId')=upper($7)
        AND inbox.external_message_id=$6
       JOIN player_identities identity
         ON identity.provider=inbox.provider
        AND identity.external_id=$5 AND identity.player_id=$1
        AND identity.status='ACTIVE'
       JOIN solo_incidental_menu_snapshots menu
         ON menu.id=receipt.menu_id
        AND menu.player_id=$1
        AND menu.encounter_id=receipt.encounter_id
        AND menu.outcome_id=receipt.outcome_id
        AND menu.encounter_revision=receipt.encounter_revision
        AND menu.panel->>'mode'='ACTIONABLE'
        AND menu.panel->'actions' ? 'BATTLE'
       JOIN solo_incidental_menu_deliveries delivery
         ON delivery.menu_id=menu.id
        AND delivery.player_id=$1
        AND delivery.provider='baileys'
        AND delivery.chat_ref=$5
        AND upper(delivery.external_message_id)=upper($7)
       JOIN outbox_messages outbound
         ON outbound.channel='whatsapp'
        AND outbound.message_type='TEXT'
        AND outbound.status='SENT' AND outbound.sent_at IS NOT NULL
        AND outbound.destination_ref=$5
        AND upper(replace(outbound.id::text,'-',''))=upper(delivery.external_message_id)
        AND outbound.payload->>'text'=menu.panel->>'text'
        AND outbound.payload->'expeditionMenu'->>'menuId'=menu.id::text
        AND outbound.payload->'expeditionMenu'->>'mode'='ACTIONABLE'
        AND outbound.payload->'expeditionMenu'->'actions'=menu.panel->'actions'
        AND outbound.payload->'expeditionMenu'->'ballItemIds'=menu.ball_item_ids
        AND outbound.payload->'expeditionSearch'->>'playerId'=$1::text
        AND outbound.payload->'expeditionSearch'->>'outcomeId'=receipt.outcome_id::text
        AND outbound.payload->'expeditionSearch'->>'encounterId'=receipt.encounter_id::text
       JOIN battles battle
         ON battle.id=receipt.battle_id
        AND battle.encounter_id=receipt.encounter_id
        AND battle.battle_type='WILD'
        AND battle.status<>'CREATED'
       JOIN battle_state_snapshots initial
         ON initial.battle_id=battle.id AND initial.version=0
       WHERE receipt.player_id=$1
         AND receipt.idempotency_key=$2
         AND receipt.inbox_message_id=$3
       LIMIT 2`,
      [
        input.playerId,
        input.context.idempotencyKey,
        input.context.inboxMessageId,
        inboxFingerprint,
        message.senderRef,
        message.externalMessageId,
        message.replyToExternalMessageId,
      ],
    );
    if (result.rows.length === 0) return ok(null);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row === undefined) {
      return err(appError("FLOW_BLOCKED", "PvE recovery has ambiguous battle receipts"));
    }
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          input.playerId,
          row.outcome_id,
          row.encounter_id,
          row.encounter_revision,
          row.menu_id,
          input.context.inboxMessageId,
          inboxFingerprint,
          message.senderRef,
        ]),
      )
      .digest("hex");
    if (
      !/^[a-f0-9-]{36}$/iu.test(row.battle_id) ||
      !/^[0-9]+$/u.test(row.encounter_revision) ||
      row.fingerprint !== expected
    ) {
      return err(appError("FLOW_BLOCKED", "PvE recovery receipt has mismatched provenance"));
    }
    return ok({ battleId: row.battle_id });
  }
}
