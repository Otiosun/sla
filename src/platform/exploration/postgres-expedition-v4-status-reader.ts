import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import type { ExpeditionV4StatusFacts } from "../../modules/exploration/expedition-v4-readonly-whatsapp.js";
import type { ExpeditionPeriod } from "../../modules/exploration/expedition-clock.js";
import type {
  ExpeditionPhase,
  ExpeditionEndReason,
} from "../../modules/exploration/expedition-state.js";
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
 * Staging-only, immutable read of the DRAFT expedition tables. A read-only
 * repeatable-read PostgreSQL transaction ensures current row + weekly count
 * are coherent; no FOR UPDATE, no quota reservation, no encounter writes.
 * Do NOT compose without a dedicated isolated database with the draft schema.
 */
export class PostgresExpeditionV4StatusReader {
  public constructor(private readonly pool: Pool) {}

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
}
