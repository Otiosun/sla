import type { Pool } from "pg";
import type { ExpeditionPeriod } from "../../modules/exploration/expedition-clock.js";
import type {
  ExpeditionEndReason,
  ExpeditionPhase,
  ExpeditionSnapshot,
} from "../../modules/exploration/expedition-state.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

interface SnapshotRow {
  readonly id: string;
  readonly player_id: string;
  readonly period: ExpeditionPeriod;
  readonly area_id: string;
  readonly current_area_id: string;
  readonly phase: ExpeditionPhase;
  readonly elapsed_minutes: number;
  readonly consumed_week_key: string | null;
  readonly end_reason: ExpeditionEndReason | null;
  readonly revision: string;
}

export interface ExpeditionPreviewFacts {
  readonly expedition: ExpeditionSnapshot | null;
  readonly usedThisWeek: number;
}

/**
 * One consistent database snapshot for a read-only Rotom menu.
 * Does not acquire write locks, consume minutes, reserve a weekly slot,
 * register WhatsApp commands or modify the World.
 */
export class PostgresExpeditionPreviewReader {
  public constructor(private readonly pool: Pool) {}

  public async read(playerId: PlayerId, weekKey: string): Promise<ExpeditionPreviewFacts> {
    return withTransaction(
      this.pool,
      async (client) => {
        const current = await client.query<SnapshotRow>(
          `SELECT id::text,player_id::text,period,area_id::text,
                  COALESCE(current_area_id,area_id)::text AS current_area_id,
                  phase,elapsed_minutes,consumed_week_key::text,end_reason,
                  revision::text
             FROM solo_expeditions WHERE player_id=$1 AND phase <> 'ENDED'`,
          [playerId],
        );
        const count = await client.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total FROM solo_expeditions
            WHERE player_id=$1 AND consumed_week_key=$2::date`,
          [playerId, weekKey],
        );
        const row = current.rows[0];
        return {
          expedition:
            row === undefined
              ? null
              : {
                  expeditionId: row.id,
                  playerId: row.player_id,
                  period: row.period,
                  areaId: row.area_id,
                  currentAreaId: row.current_area_id,
                  phase: row.phase,
                  elapsedMinutes: row.elapsed_minutes,
                  consumedWeekKey: row.consumed_week_key,
                  endReason: row.end_reason,
                  revision: BigInt(row.revision),
                },
          usedThisWeek: count.rows[0]?.total ?? 0,
        };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
