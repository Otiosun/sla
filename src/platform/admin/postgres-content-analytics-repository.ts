import type { Pool } from "pg";
import type { AdminEnvironment } from "../../modules/admin/contracts.js";
import type {
  ContentAnalyticsAggregateEvidence,
  ContentAnalyticsReadRepository,
} from "../../modules/admin/content-analytics-service.js";
import { withTransaction } from "../db/transaction.js";

interface EncounterAggregateRow {
  readonly created: string;
  readonly closed: string;
}

interface CaptureAggregateRow {
  readonly attempts_created: string;
  readonly captured: string;
  readonly failed: string;
}

interface ProgressionXpAggregateRow {
  readonly xp_awards: string;
  readonly xp_awarded: string;
}

interface ProgressionEvolutionAggregateRow {
  readonly evolutions: string;
}

export class PostgresContentAnalyticsRepository implements ContentAnalyticsReadRepository {
  public constructor(private readonly pool: Pool) {}

  public async readAggregate(
    environment: AdminEnvironment,
    asOf: Date,
  ): Promise<ContentAnalyticsAggregateEvidence> {
    void environment;

    return withTransaction(
      this.pool,
      async (client) => {
        const encounters = await client.query<EncounterAggregateRow>(
          `SELECT
             (
               SELECT count(*)::text
               FROM encounters
               WHERE created_at >= $1::timestamptz - interval '30 days'
                 AND created_at < $1::timestamptz
             ) AS created,
             (
               SELECT count(*)::text
               FROM encounters
               WHERE closed_at >= $1::timestamptz - interval '30 days'
                 AND closed_at < $1::timestamptz
             ) AS closed`,
          [asOf],
        );
        const captures = await client.query<CaptureAggregateRow>(
          `SELECT
             (
               SELECT count(*)::text
               FROM capture_attempts
               WHERE created_at >= $1::timestamptz - interval '30 days'
                 AND created_at < $1::timestamptz
             ) AS attempts_created,
             (
               SELECT count(*)::text
               FROM capture_attempts
               WHERE status = 'CAPTURED'
                 AND resolved_at >= $1::timestamptz - interval '30 days'
                 AND resolved_at < $1::timestamptz
             ) AS captured,
             (
               SELECT count(*)::text
               FROM capture_attempts
               WHERE status = 'FAILED'
                 AND resolved_at >= $1::timestamptz - interval '30 days'
                 AND resolved_at < $1::timestamptz
             ) AS failed`,
          [asOf],
        );
        const xp = await client.query<ProgressionXpAggregateRow>(
          `SELECT
             count(*)::text AS xp_awards,
             COALESCE(sum(awarded_xp), 0)::text AS xp_awarded
           FROM pokemon_xp_ledger
           WHERE created_at >= $1::timestamptz - interval '30 days'
             AND created_at < $1::timestamptz`,
          [asOf],
        );
        const evolutions = await client.query<ProgressionEvolutionAggregateRow>(
          `SELECT count(*)::text AS evolutions
           FROM pokemon_evolution_claims
           WHERE evolved_at >= $1::timestamptz - interval '30 days'
             AND evolved_at < $1::timestamptz`,
          [asOf],
        );

        const encounterRow = encounters.rows[0];
        const captureRow = captures.rows[0];
        const xpRow = xp.rows[0];
        const evolutionRow = evolutions.rows[0];
        if (
          encounterRow === undefined ||
          captureRow === undefined ||
          xpRow === undefined ||
          evolutionRow === undefined
        ) {
          throw new Error("Content analytics aggregate query did not return a row");
        }

        return {
          encounters: {
            created: encounterRow.created,
            closed: encounterRow.closed,
          },
          captures: {
            attemptsCreated: captureRow.attempts_created,
            captured: captureRow.captured,
            failed: captureRow.failed,
          },
          progression: {
            xpAwards: xpRow.xp_awards,
            xpAwarded: xpRow.xp_awarded,
            evolutions: evolutionRow.evolutions,
          },
        };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
