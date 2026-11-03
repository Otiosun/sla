import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

interface ResourceRecoveryRow {
  readonly expedition_id: string;
  readonly result_revision: string;
  readonly effect_ref: string;
  readonly result_id: string;
  readonly kind: "ITEM" | "NONE";
  readonly item_id: string | null;
  readonly item_name: string | null;
  readonly quantity: string;
  readonly ledger_id: string | null;
  readonly ledger_balance: string | null;
  readonly result_elapsed: string;
  readonly result_phase: string;
  readonly consumed_slot: boolean;
  readonly fingerprint: string;
}

export interface RecoveredResourceConfirmation {
  readonly kind: "ITEM" | "NONE";
  readonly displayName: string | null;
  readonly quantity: bigint;
  readonly elapsedMinutes: number;
  readonly consumedWeeklySlot: boolean;
}

/**
 * Read-only post-commit recovery. Only an originally claimed Inbox and its
 * exact sender, group, payload hash and ACTION_RESOURCE_SEARCH receipt may
 * recover a result. An item needs its original canonical inventory ledger.
 * A second WhatsApp message cannot adopt an existing grant or re-roll.
 */
export class PostgresExpeditionResourceConfirmationRecovery {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async resolve(input: {
    readonly playerId: PlayerId;
    readonly context: MessageHandlerContext;
  }): Promise<Result<RecoveredResourceConfirmation | null>> {
    const message = input.context.message;
    if (
      process.env.APP_ENV !== "test" ||
      process.env.NODE_ENV !== "test" ||
      process.env.WHATSAPP_ENABLED !== "false" ||
      message.provider !== "baileys" ||
      !/^\/explorar\s+(?:2|recursos)$/iu.test(message.text?.trim() ?? "")
    ) {
      return ok(null);
    }
    const found = await this.pool.query<ResourceRecoveryRow>(
      `SELECT receipt.expedition_id::text AS expedition_id,
              receipt.result->'expedition'->>'revision' AS result_revision,
              receipt.result->>'effectRef' AS effect_ref,
              resource.id::text AS result_id,
              resource.kind,
              resource.item_id::text,
              item.display_name AS item_name,
              resource.quantity::text,
              resource.ledger_id::text,
              ledger.balance_after::text AS ledger_balance,
              receipt.result->'expedition'->>'elapsedMinutes' AS result_elapsed,
              receipt.result->'expedition'->>'phase' AS result_phase,
              (receipt.result->>'consumedWeeklySlot')::boolean AS consumed_slot,
              receipt.fingerprint
       FROM inbox_messages inbox
       JOIN player_identities identity
         ON identity.provider=inbox.provider
        AND identity.external_id=$5
        AND identity.player_id=$2
        AND identity.status='ACTIVE'
       JOIN solo_expedition_receipts receipt
         ON receipt.player_id=identity.player_id
        AND receipt.idempotency_key=$3
        AND receipt.operation='ACTION_RESOURCE_SEARCH'
       JOIN solo_expedition_resource_results resource
         ON resource.player_id=receipt.player_id
        AND resource.expedition_id=receipt.expedition_id
        AND resource.id::text=receipt.result->>'effectRef'
       JOIN content_releases release
         ON release.id=resource.content_release_id
        AND release.status IN ('PUBLISHED','ARCHIVED')
       LEFT JOIN item_revisions item
         ON item.content_release_id=resource.content_release_id
        AND item.item_id=resource.item_id
       LEFT JOIN inventory_ledger ledger
         ON ledger.id=resource.ledger_id
        AND ledger.player_id=resource.player_id
        AND ledger.item_id=resource.item_id
        AND ledger.delta=resource.quantity
        AND ledger.source_type='EXPEDITION_RESOURCE'
        AND ledger.source_id=resource.id::text
       WHERE inbox.id=$1
         AND inbox.provider='baileys'
         AND inbox.status='PROCESSING'
         AND inbox.external_message_id=$6
         AND inbox.payload_hash=$4
         AND inbox.normalized_payload->>'senderRef'=$5
         AND inbox.normalized_payload->>'chatRef'=$7
         AND lower(trim(inbox.normalized_payload->>'text'))=lower($8)
       LIMIT 2`,
      [
        input.context.inboxMessageId,
        input.playerId,
        input.context.idempotencyKey,
        incomingMessageFingerprint(message),
        message.senderRef,
        message.externalMessageId,
        message.chatRef,
        message.text?.trim(),
      ],
    );
    const row = found.rows[0];
    if (row === undefined) return ok(null);
    if (found.rows.length !== 1) {
      return err(appError("FLOW_BLOCKED", "Ambiguous resource confirmation receipt"));
    }
    const nextRevision = BigInt(row.result_revision);
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "ACTION_RESOURCE_SEARCH",
          row.expedition_id,
          (nextRevision - 1n).toString(),
          60,
        ]),
      )
      .digest("hex");
    const elapsedMinutes = Number(row.result_elapsed);
    if (
      nextRevision < 1n ||
      row.fingerprint !== expected ||
      row.effect_ref !== row.result_id ||
      row.result_phase !== "ACTIVE" && row.result_phase !== "ENDED" ||
      !Number.isSafeInteger(elapsedMinutes) ||
      elapsedMinutes < 60 ||
      elapsedMinutes > 720 ||
      !/^(0|[1-9][0-9]*)$/u.test(row.quantity)
    ) {
      return err(appError("FLOW_BLOCKED", "Corrupted resource receipt"));
    }
    const quantity = BigInt(row.quantity);
    if (
      (row.kind === "ITEM" &&
        (row.item_id === null ||
          row.item_name === null ||
          row.ledger_id === null ||
          row.ledger_balance === null ||
          quantity <= 0n)) ||
      (row.kind === "NONE" &&
        (row.item_id !== null || row.ledger_id !== null || quantity !== 0n))
    ) {
      return err(appError("FLOW_BLOCKED", "Resource inventory provenance is incomplete"));
    }
    return ok({
      kind: row.kind,
      displayName: row.item_name,
      quantity,
      elapsedMinutes,
      consumedWeeklySlot: row.consumed_slot,
    });
  }
}
