import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";

interface EndRecoveryRow {
  readonly expedition_id: string;
  readonly revision: string;
  readonly elapsed_minutes: number;
  readonly fingerprint: string;
}

/**
 * Explicit test-only recovery for a VOLUNTARY end that COMMITTED before
 * Inbox completion. The exact original Inbox, player identity, payload
 * fingerprint and canonical immutable END receipt must agree.
 *
 * No mutation and no second weekly charge. This is not wired into Baileys.
 */
export class PostgresExpeditionEndConfirmationRecovery {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async resolve(input: {
    readonly playerId: PlayerId;
    readonly context: MessageHandlerContext;
  }): Promise<Result<{ readonly elapsedMinutes: number } | null>> {
    const message = input.context.message;
    if (
      process.env.APP_ENV !== "test" ||
      process.env.NODE_ENV !== "test" ||
      process.env.WHATSAPP_ENABLED !== "false" ||
      message.provider !== "baileys" ||
      message.text?.trim().toLocaleLowerCase("pt-BR") !== "/explorar encerrar confirmar"
    ) {
      return ok(null);
    }

    const found = await this.pool.query<EndRecoveryRow>(
      `SELECT expedition.id::text AS expedition_id,
              expedition.revision::text AS revision,
              expedition.elapsed_minutes,
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
        AND receipt.operation='END'
       JOIN solo_expeditions expedition
         ON expedition.id=receipt.expedition_id
        AND expedition.player_id=identity.player_id
        AND expedition.phase='ENDED'
        AND expedition.end_reason='VOLUNTARY'
        AND expedition.revision::text=receipt.result->'expedition'->>'revision'
        AND receipt.result->'expedition'->>'phase'='ENDED'
        AND receipt.result->'expedition'->>'endReason'='VOLUNTARY'
        AND expedition.elapsed_minutes::text=receipt.result->'expedition'->>'elapsedMinutes'
       WHERE inbox.id=$1
         AND inbox.provider='baileys'
         AND inbox.status='PROCESSING'
         AND inbox.external_message_id=$6
         AND inbox.payload_hash=$4
         AND inbox.normalized_payload->>'senderRef'=$5
         AND inbox.normalized_payload->>'chatRef'=$7
         AND lower(trim(inbox.normalized_payload->>'text'))='/explorar encerrar confirmar'
       LIMIT 2`,
      [
        input.context.inboxMessageId,
        input.playerId,
        input.context.idempotencyKey,
        incomingMessageFingerprint(message),
        message.senderRef,
        message.externalMessageId,
        message.chatRef,
      ],
    );
    if (found.rows.length === 0) return ok(null);
    const receipt = found.rows[0];
    if (found.rows.length !== 1 || receipt === undefined) {
      return err(appError("FLOW_BLOCKED", "Expedition closure recovery was ambiguous"));
    }
    if (!/^[1-9][0-9]*$/u.test(receipt.revision)) {
      return err(appError("FLOW_BLOCKED", "Committed closure revision is invalid"));
    }
    const revision = BigInt(receipt.revision);
    const expected = createHash("sha256")
      .update(JSON.stringify(["END", receipt.expedition_id, (revision - 1n).toString(), "VOLUNTARY"]))
      .digest("hex");
    if (
      !/^[a-f0-9-]{36}$/iu.test(receipt.expedition_id) ||
      revision < 1n ||
      receipt.fingerprint !== expected ||
      !Number.isSafeInteger(receipt.elapsed_minutes) ||
      receipt.elapsed_minutes <= 0 ||
      receipt.elapsed_minutes > 720
    ) {
      return err(appError("FLOW_BLOCKED", "Committed closure receipt is inconsistent"));
    }
    return ok({ elapsedMinutes: receipt.elapsed_minutes });
  }
}
