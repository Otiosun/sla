import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  IncomingMessageSchema,
  incomingMessageFingerprint,
  type InboxClaim,
  type IncomingMessage,
  type MessageHandlerResult,
  type MessagingRateLimitDecision,
  type MessagingRateLimitRule,
  type PendingMediaJob,
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

interface MediaJobRow {
  readonly id: string;
  readonly inbox_message_id: string;
  readonly provider: string;
  readonly provider_media_id: string;
  readonly media_kind: PendingMediaJob["mediaKind"];
  readonly mime_type: string | null;
  readonly file_name: string | null;
  readonly processor_key: string;
  readonly correlation_id: string;
  readonly attempts: number;
}

interface RateBucketRow {
  readonly window_started_at: Date;
  readonly used: number;
}

interface ResolvedRateRule {
  readonly rule: MessagingRateLimitRule;
  readonly subjectHash: string;
  readonly bucketKey: string;
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

function subjectHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateRateRules(rules: readonly MessagingRateLimitRule[]): Result<void> {
  for (const rule of rules) {
    if (
      rule.policyKey.trim().length === 0 ||
      !Number.isSafeInteger(rule.maxEvents) ||
      rule.maxEvents <= 0 ||
      !Number.isSafeInteger(rule.windowMs) ||
      rule.windowMs <= 0 ||
      (rule.scope === "ACTION" && (rule.actionKey === null || rule.actionKey.trim().length === 0))
    ) {
      return err(appError("VALIDATION_FAILED", "Messaging rate-limit rule is invalid"));
    }
  }
  return ok(undefined);
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

  async consumeRateLimits(input: {
    readonly inboxMessageId: string;
    readonly message: IncomingMessage;
    readonly rules: readonly MessagingRateLimitRule[];
  }): Promise<Result<MessagingRateLimitDecision>> {
    const validRules = validateRateRules(input.rules);
    if (!validRules.ok) return validRules;
    if (input.rules.length === 0) {
      return ok({ allowed: true, replayed: false, limitedScope: null, retryAfterMs: 0 });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingCharges = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM messaging_rate_limit_charges
         WHERE inbox_message_id = $1`,
        [input.inboxMessageId],
      );
      if ((existingCharges.rows[0]?.count ?? 0) > 0) {
        await client.query("COMMIT");
        return ok({ allowed: true, replayed: true, limitedScope: null, retryAfterMs: 0 });
      }

      const identity = await client.query<{ player_id: string }>(
        `SELECT player_id
         FROM player_identities
         WHERE provider = $1 AND external_id = $2 AND status = 'ACTIVE'`,
        [input.message.provider, input.message.senderRef],
      );
      const resolvedPlayerId = identity.rows[0]?.player_id ?? null;
      if (resolvedPlayerId !== null) {
        const bound = await client.query(
          `UPDATE inbox_messages
           SET player_id = $2
           WHERE id = $1 AND (player_id IS NULL OR player_id = $2)`,
          [input.inboxMessageId, resolvedPlayerId],
        );
        if (bound.rowCount !== 1) {
          throw new Error("Inbox player identity changed during rate-limit admission");
        }
      }

      const playerSubject =
        resolvedPlayerId === null
          ? `external:${input.message.provider}:${input.message.senderRef}`
          : `player:${resolvedPlayerId}`;
      const resolvedRules: ResolvedRateRule[] = input.rules.map((rule) => {
        const material =
          rule.scope === "CHAT"
            ? `chat:${input.message.provider}:${input.message.chatRef}`
            : rule.scope === "ACTION"
              ? `${playerSubject}:action:${rule.actionKey ?? ""}`
              : playerSubject;
        const hash = subjectHash(material);
        return {
          rule,
          subjectHash: hash,
          bucketKey: `${rule.scope}:${hash}:${rule.policyKey}`,
        };
      });

      for (const key of [...new Set(resolvedRules.map((resolved) => resolved.bucketKey))].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      }

      const nowResult = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = nowResult.rows[0]?.now;
      if (now === undefined) throw new Error("Database clock did not return a timestamp");

      const bucketStates = new Map<string, RateBucketRow | null>();
      for (const resolved of resolvedRules) {
        const bucket = await client.query<RateBucketRow>(
          `SELECT window_started_at, used
           FROM messaging_rate_limit_buckets
           WHERE scope_kind = $1 AND subject_hash = $2 AND policy_key = $3
           FOR UPDATE`,
          [resolved.rule.scope, resolved.subjectHash, resolved.rule.policyKey],
        );
        const row = bucket.rows[0] ?? null;
        bucketStates.set(resolved.bucketKey, row);
        if (row === null) continue;
        const elapsedMs = now.getTime() - row.window_started_at.getTime();
        if (elapsedMs < resolved.rule.windowMs && row.used >= resolved.rule.maxEvents) {
          await client.query("COMMIT");
          return ok({
            allowed: false,
            replayed: false,
            limitedScope: resolved.rule.scope,
            retryAfterMs: Math.max(1, resolved.rule.windowMs - elapsedMs),
          });
        }
      }

      for (const resolved of resolvedRules) {
        const current = bucketStates.get(resolved.bucketKey) ?? null;
        const expired =
          current !== null &&
          now.getTime() - current.window_started_at.getTime() >= resolved.rule.windowMs;
        const windowStartedAt = current === null || expired ? now : current.window_started_at;
        if (current === null) {
          await client.query(
            `INSERT INTO messaging_rate_limit_buckets(
               scope_kind, subject_hash, policy_key, window_started_at, used, updated_at
             ) VALUES ($1, $2, $3, $4, 1, $4)`,
            [resolved.rule.scope, resolved.subjectHash, resolved.rule.policyKey, windowStartedAt],
          );
        } else if (expired) {
          await client.query(
            `UPDATE messaging_rate_limit_buckets
             SET window_started_at = $4, used = 1, updated_at = $4
             WHERE scope_kind = $1 AND subject_hash = $2 AND policy_key = $3`,
            [resolved.rule.scope, resolved.subjectHash, resolved.rule.policyKey, windowStartedAt],
          );
        } else {
          await client.query(
            `UPDATE messaging_rate_limit_buckets
             SET used = used + 1, updated_at = $4
             WHERE scope_kind = $1 AND subject_hash = $2 AND policy_key = $3`,
            [resolved.rule.scope, resolved.subjectHash, resolved.rule.policyKey, now],
          );
        }
        await client.query(
          `INSERT INTO messaging_rate_limit_charges(
             inbox_message_id, scope_kind, subject_hash, policy_key, window_started_at, charged_at
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.inboxMessageId,
            resolved.rule.scope,
            resolved.subjectHash,
            resolved.rule.policyKey,
            windowStartedAt,
            now,
          ],
        );
      }

      await client.query("COMMIT");
      return ok({ allowed: true, replayed: false, limitedScope: null, retryAfterMs: 0 });
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
      const inbox = await client.query<{
        correlation_id: string;
        status: string;
        normalized_payload: unknown | null;
      }>(
        `SELECT correlation_id, status, normalized_payload
         FROM inbox_messages
         WHERE id = $1
         FOR UPDATE`,
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

      if ((result.mediaProcessing?.length ?? 0) > 0) {
        const normalized = IncomingMessageSchema.safeParse(row.normalized_payload);
        if (!normalized.success) {
          await client.query("ROLLBACK");
          return err(appError("VALIDATION_FAILED", "Inbox normalized payload is unavailable"));
        }
        for (const request of result.mediaProcessing ?? []) {
          const reference = normalized.data.mediaRefs.find(
            (candidate) => candidate.providerMediaId === request.providerMediaId,
          );
          if (reference === undefined) {
            await client.query("ROLLBACK");
            return err(
              appError("VALIDATION_FAILED", "Requested media is not present in the Inbox payload"),
            );
          }
          await client.query(
            `INSERT INTO messaging_media_jobs(
               id, inbox_message_id, provider, provider_media_id, media_kind, mime_type,
               file_name, processor_key, status, attempts, next_attempt_at, correlation_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', 0, now(), $9)
             ON CONFLICT (inbox_message_id, provider_media_id, processor_key) DO NOTHING`,
            [
              randomUUID(),
              inboxMessageId,
              normalized.data.provider,
              reference.providerMediaId,
              reference.kind,
              reference.mimeType,
              reference.fileName,
              request.processorKey,
              row.correlation_id,
            ],
          );
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

  async claimMediaJobs(input: {
    readonly limit: number;
    readonly staleAfterMs: number;
    readonly maxAttempts: number;
  }): Promise<readonly PendingMediaJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE messaging_media_jobs
         SET status = 'FAILED', next_attempt_at = now(), processing_started_at = NULL,
             last_error_code = 'MEDIA_LEASE_EXPIRED'
         WHERE status = 'PROCESSING'
           AND processing_started_at IS NOT NULL
           AND processing_started_at <= now() - ($1::bigint * interval '1 millisecond')`,
        [input.staleAfterMs],
      );
      await client.query(
        `UPDATE messaging_media_jobs
         SET status = 'DEAD', next_attempt_at = NULL, processing_started_at = NULL
         WHERE status IN ('PENDING', 'FAILED') AND attempts >= $1`,
        [input.maxAttempts],
      );
      const claimed = await client.query<MediaJobRow>(
        `WITH candidates AS (
           SELECT id
           FROM messaging_media_jobs
           WHERE status IN ('PENDING', 'FAILED')
             AND attempts < $1
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE messaging_media_jobs AS job
         SET status = 'PROCESSING', attempts = job.attempts + 1,
             processing_started_at = now(), last_error_code = NULL
         FROM candidates
         WHERE job.id = candidates.id
         RETURNING job.id, job.inbox_message_id, job.provider, job.provider_media_id,
                   job.media_kind, job.mime_type, job.file_name, job.processor_key,
                   job.correlation_id, job.attempts`,
        [input.maxAttempts, input.limit],
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({
        id: row.id,
        inboxMessageId: row.inbox_message_id,
        provider: row.provider,
        providerMediaId: row.provider_media_id,
        mediaKind: row.media_kind,
        mimeType: row.mime_type,
        fileName: row.file_name,
        processorKey: row.processor_key,
        correlationId: row.correlation_id,
        attempts: row.attempts,
      }));
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markMediaJobProcessed(mediaJobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE messaging_media_jobs
       SET status = 'PROCESSED', processed_at = now(), processing_started_at = NULL,
           next_attempt_at = NULL, last_error_code = NULL
       WHERE id = $1 AND status = 'PROCESSING'`,
      [mediaJobId],
    );
  }

  async markMediaJobFailed(input: {
    readonly mediaJobId: string;
    readonly errorCode: string;
    readonly retryAt: Date | null;
    readonly maxAttempts: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE messaging_media_jobs
       SET status = CASE WHEN attempts >= $4 OR $3::timestamptz IS NULL THEN 'DEAD' ELSE 'FAILED' END,
           next_attempt_at = CASE WHEN attempts >= $4 THEN NULL ELSE $3::timestamptz END,
           processing_started_at = NULL,
           last_error_code = $2
       WHERE id = $1 AND status = 'PROCESSING'`,
      [input.mediaJobId, input.errorCode, input.retryAt, input.maxAttempts],
    );
  }
}
