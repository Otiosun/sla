import type { Pool } from "pg";
import type {
  MessagingInboxCounts,
  MessagingInboxMetadataEvidence,
  MessagingInboxStatus,
  MessagingOperationsEvidence,
  MessagingOperationsReadRepository,
  MessagingOutboxCounts,
  MessagingOutboxMetadataEvidence,
  MessagingOutboxStatus,
} from "../../modules/admin/messaging-operations-read-contracts.js";

interface InboxCountRow {
  readonly status: MessagingInboxStatus;
  readonly count: number;
}

interface InboxMetadataRow {
  readonly id: string;
  readonly status: MessagingInboxStatus;
  readonly attempts: number;
  readonly received_at: Date;
  readonly processed_at: Date | null;
  readonly processing_started_at: Date | null;
}

interface OutboxCountRow {
  readonly status: MessagingOutboxStatus;
  readonly count: number;
}

interface OutboxMetadataRow {
  readonly id: string;
  readonly status: MessagingOutboxStatus;
  readonly attempts: number;
  readonly next_attempt_at: Date | null;
  readonly created_at: Date;
  readonly sent_at: Date | null;
  readonly sending_started_at: Date | null;
}

function inboxCounts(rows: readonly InboxCountRow[]): MessagingInboxCounts {
  const counts: Record<MessagingInboxStatus, number> = {
    RECEIVED: 0,
    PROCESSING: 0,
    PROCESSED: 0,
    FAILED: 0,
  };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

function outboxCounts(rows: readonly OutboxCountRow[]): MessagingOutboxCounts {
  const counts: Record<MessagingOutboxStatus, number> = {
    PENDING: 0,
    SENDING: 0,
    SENT: 0,
    FAILED: 0,
    DEAD: 0,
  };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

function inboxMetadata(row: InboxMetadataRow): MessagingInboxMetadataEvidence {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    processingStartedAt: row.processing_started_at,
  };
}

function outboxMetadata(row: OutboxMetadataRow): MessagingOutboxMetadataEvidence {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    sendingStartedAt: row.sending_started_at,
  };
}

export class PostgresMessagingOperationsReadRepository
  implements MessagingOperationsReadRepository
{
  public constructor(private readonly pool: Pool) {}

  public async readSnapshot(limit: number): Promise<MessagingOperationsEvidence> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new RangeError("Messaging operations read limit must be between 1 and 25");
    }

    const [inboxCountResult, inboxRecentResult, outboxCountResult, outboxRecentResult, deadResult] =
      await Promise.all([
        this.pool.query<InboxCountRow>(
          `SELECT status, count(*)::integer AS count
           FROM inbox_messages
           GROUP BY status`,
        ),
        this.pool.query<InboxMetadataRow>(
          `SELECT id, status, attempts, received_at, processed_at, processing_started_at
           FROM inbox_messages
           ORDER BY received_at DESC, id DESC
           LIMIT $1`,
          [limit],
        ),
        this.pool.query<OutboxCountRow>(
          `SELECT status, count(*)::integer AS count
           FROM outbox_messages
           GROUP BY status`,
        ),
        this.pool.query<OutboxMetadataRow>(
          `SELECT id, status, attempts, next_attempt_at, created_at, sent_at, sending_started_at
           FROM outbox_messages
           ORDER BY created_at DESC, id DESC
           LIMIT $1`,
          [limit],
        ),
        this.pool.query<OutboxMetadataRow>(
          `SELECT id, status, attempts, next_attempt_at, created_at, sent_at, sending_started_at
           FROM outbox_messages
           WHERE status = 'DEAD'
           ORDER BY created_at DESC, id DESC
           LIMIT $1`,
          [limit],
        ),
      ]);

    return {
      inbox: {
        counts: inboxCounts(inboxCountResult.rows),
        recent: inboxRecentResult.rows.map(inboxMetadata),
      },
      outbox: {
        counts: outboxCounts(outboxCountResult.rows),
        recent: outboxRecentResult.rows.map(outboxMetadata),
        deadLetter: deadResult.rows.map(outboxMetadata),
      },
    };
  }
}
