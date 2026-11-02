import type { Pool } from "pg";
import { createIdempotencyKey, parseIdempotencyScope } from "../../shared-kernel/idempotency.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";

const parsedScope = parseIdempotencyScope("capture.attempt");
if (!parsedScope.ok) throw new Error("Canonical capture attempt scope is invalid");

/**
 * STAGING-ONLY post-commit confirmation recovery.
 *
 * A capture transaction may be committed while MessagingService.completeIncoming
 * fails before enqueuing the WhatsApp reply. On retry the Encounter may already
 * be CAPTURED (or its revision may have changed), so the normal live-menu proof
 * intentionally rejects that old quote. Recover ONLY the finished action
 * recorded for the SAME claimed Inbox, player, provider quote and issued Ball.
 *
 * This read never consumes another Ball, rerolls, or authorizes a new action.
 */
export class PostgresExpeditionCaptureConfirmationRecovery {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async resolve(input: {
    readonly playerId: PlayerId;
    readonly context: MessageHandlerContext;
  }): Promise<
    Result<{ readonly encounterId: string; readonly status: "CAPTURED" | "FAILED" } | null>
  > {
    const message = input.context.message;
    const choice = message.text?.trim() ?? "";
    if (
      message.provider !== "baileys" ||
      message.chatRef !== message.senderRef ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(message.senderRef) ||
      !/^[2-4]$/u.test(choice) ||
      !/^[a-f0-9]{32}$/iu.test(message.replyToExternalMessageId ?? "")
    ) {
      return ok(null);
    }

    const scoped = createIdempotencyKey(
      parsedScope.value,
      `${input.playerId}:${input.context.idempotencyKey.trim()}`,
    );
    if (!scoped.ok) return scoped;
    const fingerprint = incomingMessageFingerprint(message);
    const found = await this.pool.query<{
      encounter_id: string;
      status: "CAPTURED" | "FAILED";
    }>(
      `SELECT attempt.encounter_id::text AS encounter_id, attempt.status
       FROM inbox_messages inbox
       JOIN player_identities identity
         ON identity.provider = inbox.provider
        AND identity.external_id = $5
        AND identity.player_id = $2
        AND identity.status = 'ACTIVE'
       JOIN capture_attempts attempt
         ON attempt.player_id = identity.player_id
        AND attempt.idempotency_key = $3
        AND attempt.correlation_id = inbox.correlation_id
        AND attempt.status IN ('CAPTURED','FAILED')
        AND attempt.resolved_at IS NOT NULL
        AND attempt.source_encounter_status = 'ENGAGED'
        AND attempt.battle_id IS NULL
        AND attempt.target_wild_no = 1
       JOIN solo_incidental_menu_deliveries delivery
         ON delivery.provider = inbox.provider
        AND delivery.player_id = attempt.player_id
        AND delivery.chat_ref = $5
        AND upper(delivery.external_message_id) =
            upper(inbox.normalized_payload->>'replyToExternalMessageId')
       JOIN solo_incidental_menu_snapshots menu
         ON menu.id = delivery.menu_id
        AND menu.player_id = attempt.player_id
        AND menu.encounter_id = attempt.encounter_id
        AND menu.ball_item_ids->>$7 = attempt.ball_item_id::text
        AND menu.panel->>'mode' = 'ACTIONABLE'
        AND menu.panel->'actions' ? 'CAPTURE'
       JOIN outbox_messages outbound
         ON outbound.channel = 'whatsapp'
        AND outbound.message_type = 'TEXT'
        AND outbound.status = 'SENT'
        AND outbound.sent_at IS NOT NULL
        AND outbound.destination_ref = delivery.chat_ref
        AND upper(replace(outbound.id::text,'-','')) = upper(delivery.external_message_id)
        AND outbound.payload->'expeditionMenu'->>'menuId' = menu.id::text
        AND outbound.payload->'expeditionMenu'->>'mode' = 'ACTIONABLE'
        AND outbound.payload->'expeditionSearch'->>'playerId' = attempt.player_id::text
        AND outbound.payload->'expeditionSearch'->>'outcomeId' = menu.outcome_id::text
        AND outbound.payload->'expeditionSearch'->>'encounterId' = attempt.encounter_id::text
       WHERE inbox.id = $1
         AND inbox.status = 'PROCESSING'
         AND inbox.provider = 'baileys'
         AND inbox.external_message_id = $6
         AND inbox.payload_hash = $4
         AND inbox.normalized_payload->>'senderRef' = $5
         AND inbox.normalized_payload->>'chatRef' = $5
         AND trim(inbox.normalized_payload->>'text') = $7
       LIMIT 2`,
      [
        input.context.inboxMessageId,
        input.playerId,
        scoped.value.storageKey,
        fingerprint,
        message.senderRef,
        message.externalMessageId,
        choice,
      ],
    );
    if (found.rows.length === 0) return ok(null);
    const row = found.rows[0];
    if (
      found.rows.length !== 1 ||
      row === undefined ||
      !/^[a-f0-9-]{36}$/iu.test(row.encounter_id) ||
      (row.status !== "CAPTURED" && row.status !== "FAILED")
    ) {
      return err(appError("FLOW_BLOCKED", "Capture confirmation recovery was ambiguous"));
    }
    return ok({ encounterId: row.encounter_id, status: row.status });
  }
}
