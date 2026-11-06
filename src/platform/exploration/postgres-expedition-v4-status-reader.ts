import type { Pool } from "pg";
import type { ExpeditionPeriod } from "../../modules/exploration/expedition-clock.js";
import type {
  ExpeditionEndReason,
  ExpeditionPhase,
} from "../../modules/exploration/expedition-state.js";
import type { ExpeditionV4StatusFacts } from "../../modules/exploration/expedition-v4-readonly-whatsapp.js";
import type { MessageHandlerContext } from "../../modules/messaging/contracts.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

interface ExpeditionRow {
  readonly id: string;
  readonly player_id: string;
  readonly area_id: string;
  readonly phase: ExpeditionPhase;
  readonly period: ExpeditionPeriod;
  readonly elapsed_minutes: number;
  readonly consumed_week_key: string | null;
  readonly end_reason: ExpeditionEndReason | null;
  readonly revision: string;
}

/**
 * Counts only actual persisted outcomes: no invented species, item grants,
 * victories, captures, settlement or approved external report are inferred.
 */
export interface ExpeditionV4FactualSummary {
  readonly period: ExpeditionPeriod;
  readonly endReason: "VOLUNTARY" | "CLOCK" | "BLACKOUT";
  readonly blackoutNeedsStaff?: true;
  readonly elapsedMinutes: number;
  readonly searches: number;
  readonly noSignal: number;
  readonly trail: number;
  readonly incidental: number;
  readonly direct: number;
}

/**
 * Staging-only, immutable read of the DRAFT expedition tables. A read-only
 * repeatable-read PostgreSQL transaction ensures current row + weekly count
 * are coherent; no FOR UPDATE, no quota reservation, no encounter writes.
 * Do NOT compose without a dedicated isolated database with the draft schema.
 */
export class PostgresExpeditionV4StatusReader {
  public constructor(private readonly pool: Pool) {}

  public async isRetry(context: MessageHandlerContext): Promise<boolean> {
    const { provider, externalMessageId, senderRef } = context.message;
    const result = await this.pool.query<{ attempts: number }>(
      `SELECT attempts FROM inbox_messages
       WHERE id=$1 AND status='PROCESSING' AND provider=$2 AND external_message_id=$3
         AND normalized_payload->>'senderRef'=$4`,
      [context.inboxMessageId, provider, externalMessageId, senderRef],
    );
    return result.rows[0]?.attempts !== 1;
  }

  public async read(playerId: PlayerId, weekKey: string): Promise<ExpeditionV4StatusFacts> {
    return withTransaction(
      this.pool,
      async (client) => {
        const current = await client.query<ExpeditionRow>(
          `SELECT id::text, player_id::text, area_id::text, phase, period,
                  elapsed_minutes, consumed_week_key::text, end_reason, revision::text
           FROM solo_expeditions
           WHERE player_id=$1 AND phase <> 'ENDED'
           LIMIT 2`,
          [playerId],
        );
        // An extra active row means the source is corrupt; do not guess.
        if (current.rows.length > 1) {
          throw new Error("Exploration preview has multiple active expeditions");
        }
        const count = await client.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total
           FROM solo_expeditions
           WHERE player_id=$1 AND consumed_week_key=$2::date`,
          [playerId, weekKey],
        );
        const row = current.rows[0];
        return {
          usedThisWeek: count.rows[0]?.total ?? -1,
          expedition:
            row === undefined
              ? null
              : {
                  expeditionId: row.id,
                  playerId: row.player_id,
                  areaId: row.area_id,
                  phase: row.phase,
                  period: row.period,
                  elapsedMinutes: row.elapsed_minutes,
                  consumedWeekKey: row.consumed_week_key,
                  endReason: row.end_reason,
                  revision: BigInt(row.revision),
                },
        };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }

  /**
   * Authoritative read-only snapshot of the most recently completed,
   * non-cancelled expedition. Used only by the staging V4 /explorar resumo.
   */
  public async readLatestCompleted(playerId: PlayerId): Promise<ExpeditionV4FactualSummary | null> {
    return withTransaction(
      this.pool,
      async (client) => {
        const result = await client.query<{
          period: ExpeditionPeriod;
          end_reason: "VOLUNTARY" | "CLOCK" | "BLACKOUT";
          blackout_needs_staff: boolean;
          elapsed_minutes: number;
          searches: number;
          no_signal: number;
          trail: number;
          incidental: number;
          direct: number;
        }>(
          `SELECT expedition.period,
                  expedition.end_reason,
                  expedition.elapsed_minutes,
                  EXISTS (SELECT 1 FROM solo_expedition_receipts receipt WHERE receipt.expedition_id=expedition.id
                    AND receipt.result @> '{"blackoutNeedsStaff":true}'::jsonb) AS blackout_needs_staff,
                  COUNT(outcome.id)::int AS searches,
                  COUNT(outcome.id) FILTER (WHERE outcome.kind='NO_SIGNAL')::int AS no_signal,
                  COUNT(outcome.id) FILTER (WHERE outcome.kind='TRAIL')::int AS trail,
                  COUNT(outcome.id) FILTER (WHERE outcome.kind='INCIDENTAL')::int AS incidental,
                  COUNT(outcome.id) FILTER (WHERE outcome.kind='DIRECT')::int AS direct
           FROM solo_expeditions expedition
           LEFT JOIN solo_expedition_search_outcomes outcome
             ON outcome.expedition_id=expedition.id
            AND outcome.player_id=expedition.player_id
            AND NOT EXISTS (
              SELECT 1 FROM solo_expedition_trail_follows followed
              WHERE followed.followed_outcome_id=outcome.id
            )
           WHERE expedition.player_id=$1
             AND expedition.phase='ENDED'
             AND expedition.end_reason IN ('VOLUNTARY','CLOCK','BLACKOUT')
           GROUP BY expedition.id
           ORDER BY expedition.updated_at DESC, expedition.id DESC
           LIMIT 1`,
          [playerId],
        );
        const row = result.rows[0];
        return row === undefined
          ? null
          : {
              period: row.period,
              endReason: row.end_reason,
              ...(row.blackout_needs_staff ? { blackoutNeedsStaff: true as const } : {}),
              elapsedMinutes: row.elapsed_minutes,
              searches: row.searches,
              noSignal: row.no_signal,
              trail: row.trail,
              incidental: row.incidental,
              direct: row.direct,
            };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
