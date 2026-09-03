import type { Pool } from "pg";
import type {
  CaptureAggregate,
  EncounterAggregate,
  GameplayAnalyticsAggregateEvidence,
  GameplayAnalyticsReadRepository,
  GameplayAnalyticsWindowKey,
  TrainerProgressionAggregate,
} from "../../modules/admin/gameplay-analytics-service.js";
import type { AdminEnvironment } from "../../modules/admin/contracts.js";
import { withTransaction } from "../db/transaction.js";

const MIN_PARTICIPANTS = 5;

interface EncounterRow {
  window_key: GameplayAnalyticsWindowKey;
  participant_count: string;
  created: string;
  closed: string;
  captured: string;
  fled: string;
  expired: string;
  closed_other: string;
}

interface CaptureRow {
  window_key: GameplayAnalyticsWindowKey;
  participant_count: string;
  resolved: string;
  captured: string;
  failed: string;
}

interface ProgressionRow {
  window_key: GameplayAnalyticsWindowKey;
  participant_count: string;
  adjustments: string;
  points_added: string;
  points_removed: string;
  net_points: string;
}

const WINDOW_ORDER: readonly GameplayAnalyticsWindowKey[] = ["24h", "7d", "30d"];

function suppressed(participantCount: string): boolean {
  return BigInt(participantCount) < BigInt(MIN_PARTICIPANTS);
}

function encounterAggregate(row: EncounterRow): EncounterAggregate {
  if (suppressed(row.participant_count)) return { suppressed: true };
  return {
    suppressed: false,
    created: row.created,
    closed: row.closed,
    captured: row.captured,
    fled: row.fled,
    expired: row.expired,
    closedOther: row.closed_other,
  };
}

function captureAggregate(row: CaptureRow): CaptureAggregate {
  if (suppressed(row.participant_count)) return { suppressed: true };
  return {
    suppressed: false,
    resolved: row.resolved,
    captured: row.captured,
    failed: row.failed,
  };
}

function progressionAggregate(row: ProgressionRow): TrainerProgressionAggregate {
  if (suppressed(row.participant_count)) return { suppressed: true };
  return {
    suppressed: false,
    adjustments: row.adjustments,
    pointsAdded: row.points_added,
    pointsRemoved: row.points_removed,
    netPoints: row.net_points,
  };
}

function rowByWindow<T extends { readonly window_key: GameplayAnalyticsWindowKey }>(
  rows: readonly T[],
  window: GameplayAnalyticsWindowKey,
): T {
  const row = rows.find((candidate) => candidate.window_key === window);
  if (row === undefined) throw new Error(`Gameplay analytics query omitted ${window}`);
  return row;
}

export class PostgresGameplayAnalyticsRepository implements GameplayAnalyticsReadRepository {
  public constructor(private readonly pool: Pool) {}

  public async readAggregate(
    environment: AdminEnvironment,
    asOf: Date,
  ): Promise<GameplayAnalyticsAggregateEvidence> {
    void environment;

    return withTransaction(
      this.pool,
      async (client) => {
        const encounterResult = await client.query<EncounterRow>(
          `WITH windows(window_key, ordinal, from_at) AS (
             VALUES
               ('24h'::text, 1, $1::timestamptz - interval '24 hours'),
               ('7d'::text, 2, $1::timestamptz - interval '7 days'),
               ('30d'::text, 3, $1::timestamptz - interval '30 days')
           )
           SELECT windows.window_key,
                  count(DISTINCT encounter.player_id) FILTER (
                    WHERE (encounter.created_at >= windows.from_at AND encounter.created_at < $1::timestamptz)
                       OR (encounter.closed_at >= windows.from_at AND encounter.closed_at < $1::timestamptz
                           AND encounter.status IN ('CAPTURED','FLED','EXPIRED','CLOSED'))
                  )::text AS participant_count,
                  count(*) FILTER (
                    WHERE encounter.created_at >= windows.from_at
                      AND encounter.created_at < $1::timestamptz
                  )::text AS created,
                  count(*) FILTER (
                    WHERE encounter.closed_at >= windows.from_at
                      AND encounter.closed_at < $1::timestamptz
                      AND encounter.status IN ('CAPTURED','FLED','EXPIRED','CLOSED')
                  )::text AS closed,
                  count(*) FILTER (
                    WHERE encounter.closed_at >= windows.from_at
                      AND encounter.closed_at < $1::timestamptz
                      AND encounter.status = 'CAPTURED'
                  )::text AS captured,
                  count(*) FILTER (
                    WHERE encounter.closed_at >= windows.from_at
                      AND encounter.closed_at < $1::timestamptz
                      AND encounter.status = 'FLED'
                  )::text AS fled,
                  count(*) FILTER (
                    WHERE encounter.closed_at >= windows.from_at
                      AND encounter.closed_at < $1::timestamptz
                      AND encounter.status = 'EXPIRED'
                  )::text AS expired,
                  count(*) FILTER (
                    WHERE encounter.closed_at >= windows.from_at
                      AND encounter.closed_at < $1::timestamptz
                      AND encounter.status = 'CLOSED'
                  )::text AS closed_other
           FROM windows
           LEFT JOIN encounters encounter
             ON (encounter.created_at >= windows.from_at AND encounter.created_at < $1::timestamptz)
             OR (encounter.closed_at >= windows.from_at AND encounter.closed_at < $1::timestamptz
                 AND encounter.status IN ('CAPTURED','FLED','EXPIRED','CLOSED'))
           GROUP BY windows.window_key, windows.ordinal
           ORDER BY windows.ordinal`,
          [asOf],
        );

        const captureResult = await client.query<CaptureRow>(
          `WITH windows(window_key, ordinal, from_at) AS (
             VALUES
               ('24h'::text, 1, $1::timestamptz - interval '24 hours'),
               ('7d'::text, 2, $1::timestamptz - interval '7 days'),
               ('30d'::text, 3, $1::timestamptz - interval '30 days')
           )
           SELECT windows.window_key,
                  count(DISTINCT attempt.player_id)::text AS participant_count,
                  count(attempt.id)::text AS resolved,
                  count(*) FILTER (WHERE attempt.status = 'CAPTURED')::text AS captured,
                  count(*) FILTER (WHERE attempt.status = 'FAILED')::text AS failed
           FROM windows
           LEFT JOIN capture_attempts attempt
             ON attempt.resolved_at >= windows.from_at
            AND attempt.resolved_at < $1::timestamptz
            AND attempt.status IN ('CAPTURED','FAILED')
           GROUP BY windows.window_key, windows.ordinal
           ORDER BY windows.ordinal`,
          [asOf],
        );

        const progressionResult = await client.query<ProgressionRow>(
          `WITH windows(window_key, ordinal, from_at) AS (
             VALUES
               ('24h'::text, 1, $1::timestamptz - interval '24 hours'),
               ('7d'::text, 2, $1::timestamptz - interval '7 days'),
               ('30d'::text, 3, $1::timestamptz - interval '30 days')
           )
           SELECT windows.window_key,
                  count(DISTINCT ledger.player_id)::text AS participant_count,
                  count(ledger.id)::text AS adjustments,
                  COALESCE(sum(ledger.delta) FILTER (WHERE ledger.delta > 0), 0)::text AS points_added,
                  COALESCE(sum(-ledger.delta) FILTER (WHERE ledger.delta < 0), 0)::text AS points_removed,
                  COALESCE(sum(ledger.delta), 0)::text AS net_points
           FROM windows
           LEFT JOIN trainer_progress_ledger ledger
             ON ledger.created_at >= windows.from_at
            AND ledger.created_at < $1::timestamptz
           GROUP BY windows.window_key, windows.ordinal
           ORDER BY windows.ordinal`,
          [asOf],
        );

        return {
          windows: WINDOW_ORDER.map((window) => {
            const encounter = rowByWindow(encounterResult.rows, window);
            const capture = rowByWindow(captureResult.rows, window);
            const progression = rowByWindow(progressionResult.rows, window);
            return {
              window,
              encounters: encounterAggregate(encounter),
              captures: captureAggregate(capture),
              trainerProgression: progressionAggregate(progression),
            };
          }),
        };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
