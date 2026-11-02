import type { Pool } from "pg";
import type { PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import type { ExpeditionSearchPostSentHook } from "../../modules/exploration/expedition-search-post-sent-hook.js";

interface PendingSentRow {
  readonly id: string;
  readonly destination_ref: string;
  readonly payload: Record<string, unknown>;
  readonly correlation_id: string;
}

export interface ExpeditionPostSentRecoveryResult {
  readonly attempted: number;
  readonly engaged: number;
  readonly blocked: number;
}

/**
 * Staging-only repair for the crash window AFTER Outbox SENT but BEFORE
 * engagement. Queries durable SENT receipts; never resends to WhatsApp.
 *
 * Also recovers the crash after ENGAGED but before the ACTIONABLE menu was
 * issued. A persisted menu snapshot excludes the row: Outbox handles its
 * pending delivery without ever generating a replacement.
 *
 * Concurrent recovery calls are safe because the proof, EncounterService and
 * immutable menu issuer enforce ownership and idempotent transitions.
 * Caller must provide monitoring for blocked rows. No automatic live wiring.
 */
export class PostgresExpeditionPostSentRecovery {
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly hook: Pick<ExpeditionSearchPostSentHook, "afterSent" | "onFailure">,
  ) {}

  async runOnce(limit = 25): Promise<ExpeditionPostSentRecoveryResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid staging post-SENT recovery bound");
    }
    const found = await this.pool.query<PendingSentRow>(
      `SELECT o.id::text AS id, o.destination_ref, o.payload, o.correlation_id::text AS correlation_id
       FROM outbox_messages o
       JOIN solo_expedition_search_outcomes outcome
         ON outcome.id::text = o.payload->'expeditionSearch'->>'outcomeId'
       JOIN encounters encounter
         ON encounter.id = outcome.encounter_id
        AND encounter.status IN ('CREATED', 'PRESENTED', 'ENGAGED')
       WHERE o.channel = 'whatsapp'
         AND o.message_type = 'TEXT'
         AND o.status = 'SENT'
         AND o.sent_at IS NOT NULL
         AND o.payload ? 'expeditionSearch'
         AND NOT (o.payload ? 'expeditionMenu')
         AND NOT EXISTS (
           SELECT 1 FROM solo_incidental_menu_snapshots issued
           WHERE issued.outcome_id = outcome.id
         )
       ORDER BY o.sent_at, o.id
       LIMIT $1`,
      [limit],
    );
    let engaged = 0;
    let blocked = 0;
    for (const row of found.rows) {
      const message: PendingOutboxMessage = {
        id: row.id,
        channel: "whatsapp",
        messageType: "TEXT",
        destinationRef: row.destination_ref,
        payload: row.payload,
        correlationId: row.correlation_id,
        causationId: null,
        idempotencyKey: "post-sent-recovery",
        attempts: 0,
      };
      try {
        await this.hook.afterSent(message);
        engaged += 1;
      } catch (error) {
        blocked += 1;
        this.hook.onFailure(message, error);
      }
    }
    return { attempted: found.rows.length, engaged, blocked };
  }
}
