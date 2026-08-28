import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  IncomingMessageSchema,
  incomingMessageFingerprint,
  type InboxClaim,
  type IncomingMessage,
  type MessageHandlerResult,
  type PendingOutboxMessage,
} from "../../modules/messaging/contracts.js";
import type { MessagingRepository } from "../../modules/messaging/ports.js";

interface InboxRow {
  readonly id: string;
  readonly payload_hash: string;
  readonly status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED";
  readonly normalized_payload: unknown | null;
  readonly correlation_id: string;
  readonly result_ref_type: string | null;
  readonly result_ref_id: string | null;
  readonly processing_started_at: Date | null;
}

interface OutboxRow {
  readonly id: string;
  readonly channel: string;
  readonly destination_ref: string;
  readonly message_type: string;
  readonly payload: Record<string, unknown>;
  readonly idempotency_key: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly attempts: number;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}

function persistedMessage(row: InboxRow, fallback: IncomingMessage): IncomingMessage {
  if (row.normalized_payload === null) return fallback;
  const parsed = IncomingMessageSchema.safeParse(row.normalized_payload);
  return parsed.success ? parsed.data : fallback;
}

export class PostgresMessagingRepository implements MessagingRepository {
  constructor(private readonly pool: Pool) {}

  async claimIncoming(message: IncomingMessage, leaseMs: number): Promise<Result<InboxClaim>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inboxId = randomUUID();
      const correlationId = randomUUID();
      const fingerprint = incomingMessageFingerprint(message);
      const inserted = await client.query<InboxRow>(
        `INSERT INTO inbox_messages (
           id, provider, external_message_id, player_id, payload_hash, status,
           received_at, correlation_id, normalized_payload, attempts, processing_started_at
         ) VALUES ($1, $2, $3, NULL, $4, 'PROCESSING', now(), $5, $6::jsonb, 1, now())
         ON CONFLICT (provider, external_message_id) DO NOTHING
         RETURNING id, payload_hash, status, normalized_payload, correlation_id,
                   result_ref_type, result_ref_id, processing_started_at`,
        [
          inboxId,
          message.provider,
          message.externalMessageId,
          fingerprint,
          correlationId,
          JSON.stringify(message),
        ],
      );
      const fresh = inserted.rows[0];
      if (fresh !== undefined) {
        await client.query("COMMIT");
        return ok({
          status: "CLAIMED",
          inboxMessageId: fresh.id,
          correlationId: fresh.correlation_id,
          message,
          resultRefType: null,
          resultRefId: null,
        });
      }

      const existingResult = await client.query<InboxRow>(
        `SELECT id, payload_hash, status, normalized_payload, correlation_id,
                result_ref_type, result_ref_id, processing_started_at
         FROM inbox_messages
         WHERE provider = $1 AND external_message_id = $2
         FOR UPDATE`,
        [message.provider, message.externalMessageId],
      );
      const existing = existingResult.rows[0];
      if (existing === undefined) {
        throw new Error("Inbox conflict row disappeared during claim");
      }
      if (existing.payload_hash !== fingerprint) {
        await client.query("ROLLBACK");
        return err(
          appError(
            "FINGERPRINT_MISMATCH",
            "External message id is already bound to different normalized content",
            { provider: message.provider, externalMessageId: message.externalMessageId },
          ),
        );
      }
      if (existing.status === "PROCESSED") {
        await client.query("COMMIT");
        return ok({
          status: "REPLAYED",
          inboxMessageId: existing.id,
          correlationId: existing.correlation_id,
          message: persistedMessage(existing, message),
          resultRefType: existing.result_ref_type,
          resultRefId: existing.result_ref_id,
        });
      }

      const activeLease =
        existing.status === "PROCESSING" &&
        existing.processing_started_at !== null &&
        Date.now() - existing.processing_started_at.getTime() < leaseMs;
      if (activeLease) {
        await client.query("COMMIT");
        return ok({
          status: "IN_FLIGHT",
          inboxMessageId: existing.id,
          correlationId: existing.correlation_id,
          message: persistedMessage(existing, message),
          resultRefType: null,
          resultRefId: null,
        });
      }

      await client.query(
        `UPDATE inbox_messages
         SET status = 'PROCESSING',
             attempts = attempts + 1,
             processing_started_at = now(),
             last_error_code = NULL,
             normalized_payload = COALESCE(normalized_payload, $2::jsonb)
         WHERE id = $1`,
        [existing.id, JSON.stringify(message)],
      );
      await client.query("COMMIT");
      return ok({
        status: "CLAIMED",
        inboxMessageId: existing.id,
        correlationId: existing.correlation_id,
        message: persistedMessage(existing, message),
        resultRefType: null,
        resultRefId: null,
      });
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeIncoming(
    inboxMessageId: string,
    result: MessageHandlerResult,
  ): Promise<Result<void>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inbox = await client.query<{ correlation_id: string; status: string }>(
        `SELECT correlation_id, status FROM inbox_messages WHERE id = $1 FOR UPDATE`,
        [inboxMessageId],
      );
      const row = inbox.rows[0];
      if (row === undefined || row.status !== "PROCESSING") {
        await client.query("ROLLBACK");
        return err(appError("INVALID_STATE_TRANSITION", "Inbox message is not PROCESSING"));
      }

      for (const outgoing of result.outgoing) {
        const outboxId = randomUUID();
        const insert = await client.query(
          `INSERT INTO outbox_messages (
             id, channel, destination_ref, message_type, payload, idempotency_key,
             status, attempts, next_attempt_at, correlation_id, causation_id
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'PENDING', 0, now(), $7, $8)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [
            outboxId,
            outgoing.channel,
            outgoing.destinationRef,
            outgoing.messageType,
            JSON.stringify(outgoing.payload),
            outgoing.idempotencyKey,
            row.correlation_id,
            inboxMessageId,
          ],
        );
        if (insert.rowCount === 0) {
          const semantic = await client.query<{ same: boolean }>(
            `SELECT channel = $2
                    AND destination_ref = $3
                    AND message_type = $4
                    AND payload = $5::jsonb
                    AND correlation_id = $6
                    AND causation_id = $7 AS same
             FROM outbox_messages
             WHERE idempotency_key = $1`,
            [
              outgoing.idempotencyKey,
              outgoing.channel,
              outgoing.destinationRef,
              outgoing.messageType,
              JSON.stringify(outgoing.payload),
              row.correlation_id,
              inboxMessageId,
            ],
          );
          if (semantic.rows[0]?.same !== true) {
            await client.query("ROLLBACK");
            return err(
              appError(
                "FINGERPRINT_MISMATCH",
                "Outbox idempotency key is bound to different semantic output",
                { idempotencyKey: outgoing.idempotencyKey },
              ),
            );
          }
        }
      }

      const updated = await client.query(
        `UPDATE inbox_messages
         SET status = 'PROCESSED', processed_at = now(), processing_started_at = NULL,
             result_ref_type = $2, result_ref_id = $3, last_error_code = NULL
         WHERE id = $1 AND status = 'PROCESSING'`,
        [inboxMessageId, result.resultRefType, result.resultRefId],
      );
      if (updated.rowCount !== 1) {
        throw new Error("Inbox completion lost its processing claim");
      }
      await client.query("COMMIT");
      return ok(undefined);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failIncoming(inboxMessageId: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE inbox_messages
       SET status = 'FAILED', last_error_code = $2, processing_started_at = NULL
       WHERE id = $1 AND status = 'PROCESSING'`,
      [inboxMessageId, errorCode],
    );
  }

  async claimOutbox(input: {
    readonly limit: number;
    readonly staleAfterMs: number;
    readonly maxAttempts: number;
  }): Promise<readonly PendingOutboxMessage[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE outbox_messages
         SET status = 'FAILED', next_attempt_at = now(), sending_started_at = NULL,
             last_error_code = 'SENDING_LEASE_EXPIRED'
         WHERE status = 'SENDING'
           AND sending_started_at IS NOT NULL
           AND sending_started_at <= now() - ($1::bigint * interval '1 millisecond')`,
        [input.staleAfterMs],
      );
      await client.query(
        `UPDATE outbox_messages
         SET status = 'DEAD', next_attempt_at = NULL, sending_started_at = NULL
         WHERE status IN ('PENDING', 'FAILED') AND attempts >= $1`,
        [input.maxAttempts],
      );

      const claimed = await client.query<OutboxRow>(
        `WITH candidates AS (
           SELECT id
           FROM outbox_messages
           WHERE status IN ('PENDING', 'FAILED')
             AND attempts < $1
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE outbox_messages AS message
         SET status = 'SENDING', attempts = message.attempts + 1,
             sending_started_at = now(), last_error_code = NULL
         FROM candidates
         WHERE message.id = candidates.id
         RETURNING message.id, message.channel, message.destination_ref, message.message_type,
                   message.payload, message.idempotency_key, message.correlation_id,
                   message.causation_id, message.attempts`,
        [input.maxAttempts, input.limit],
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        destinationRef: row.destination_ref,
        messageType: row.message_type,
        payload: row.payload,
        idempotencyKey: row.idempotency_key,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        attempts: row.attempts,
      }));
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markOutboxSent(outboxMessageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_messages
       SET status = 'SENT', sent_at = now(), sending_started_at = NULL,
           next_attempt_at = NULL, last_error_code = NULL
       WHERE id = $1 AND status = 'SENDING'`,
      [outboxMessageId],
    );
  }

  async markOutboxFailed(input: {
    readonly outboxMessageId: string;
    readonly errorCode: string;
    readonly retryAt: Date | null;
    readonly maxAttempts: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_messages
       SET status = CASE WHEN attempts >= $4 OR $3::timestamptz IS NULL THEN 'DEAD' ELSE 'FAILED' END,
           next_attempt_at = CASE WHEN attempts >= $4 THEN NULL ELSE $3::timestamptz END,
           sending_started_at = NULL,
           last_error_code = $2
       WHERE id = $1 AND status = 'SENDING'`,
      [input.outboxMessageId, input.errorCode, input.retryAt, input.maxAttempts],
    );
  }
}
