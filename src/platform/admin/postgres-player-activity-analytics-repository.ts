import type { Pool } from "pg";
import type {
  PlayerActivityAggregateEvidence,
  PlayerActivityAnalyticsReadRepository,
} from "../../modules/admin/player-activity-analytics-service.js";
import type { AdminEnvironment } from "../../modules/admin/contracts.js";

interface AggregateRow {
  active_24h: string;
  active_7d: string;
  active_30d: string;
  returning_7d: string;
}

export class PostgresPlayerActivityAnalyticsRepository
  implements PlayerActivityAnalyticsReadRepository
{
  public constructor(private readonly pool: Pool) {}

  public async readAggregate(
    environment: AdminEnvironment,
    asOf: Date,
  ): Promise<PlayerActivityAggregateEvidence> {
    void environment;

    const result = await this.pool.query<AggregateRow>(
      `WITH activity AS (
         SELECT player_id, created_at AS occurred_at
         FROM trainer_progress_ledger
         WHERE created_at >= $1::timestamptz - interval '30 days'
           AND created_at < $1::timestamptz
       ), per_player AS (
         SELECT player_id,
                bool_or(
                  occurred_at >= $1::timestamptz - interval '24 hours'
                  AND occurred_at < $1::timestamptz
                ) AS active_24h,
                bool_or(
                  occurred_at >= $1::timestamptz - interval '7 days'
                  AND occurred_at < $1::timestamptz
                ) AS active_7d,
                bool_or(
                  occurred_at >= $1::timestamptz - interval '30 days'
                  AND occurred_at < $1::timestamptz
                ) AS active_30d,
                bool_or(
                  occurred_at >= $1::timestamptz - interval '14 days'
                  AND occurred_at < $1::timestamptz - interval '7 days'
                ) AS prior_7d
         FROM activity
         GROUP BY player_id
       )
       SELECT count(*) FILTER (WHERE active_24h)::text AS active_24h,
              count(*) FILTER (WHERE active_7d)::text AS active_7d,
              count(*) FILTER (WHERE active_30d)::text AS active_30d,
              count(*) FILTER (WHERE active_7d AND prior_7d)::text AS returning_7d
       FROM per_player`,
      [asOf],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Player activity aggregate query returned no row");
    }

    return {
      last24Hours: Number(row.active_24h),
      last7Days: Number(row.active_7d),
      last30Days: Number(row.active_30d),
      returningPlayers7Days: Number(row.returning_7d),
    };
  }
}
