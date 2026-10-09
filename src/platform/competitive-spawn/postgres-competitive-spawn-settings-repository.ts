import type { Pool } from "pg";
import type {
  CompetitiveSpawnSettingsRepository,
  CompetitiveSpawnSettingUpdateResult,
} from "../../modules/competitive-spawn/settings.js";
import { withTransaction } from "../db/transaction.js";

export class PostgresCompetitiveSpawnSettingsRepository
  implements CompetitiveSpawnSettingsRepository
{
  public constructor(private readonly pool: Pool) {}

  public async isEnabled(communityGroupId: string): Promise<boolean> {
    const result = await this.pool.query<{ enabled: boolean }>(
      `SELECT enabled
       FROM competitive_spawn_group_settings
       WHERE community_group_id = $1`,
      [communityGroupId],
    );
    return result.rows[0]?.enabled === true;
  }

  public async setEnabled(input: {
    readonly communityGroupId: string;
    readonly enabled: boolean;
    readonly now: Date;
  }): Promise<CompetitiveSpawnSettingUpdateResult> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `competitive-spawn-settings:${input.communityGroupId}`,
      ]);

      await client.query(
        `INSERT INTO competitive_spawn_group_settings(
           community_group_id, enabled, revision, updated_at
         ) VALUES ($1, $2, 0, $3)
         ON CONFLICT (community_group_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           revision = competitive_spawn_group_settings.revision
             + CASE WHEN competitive_spawn_group_settings.enabled IS DISTINCT FROM EXCLUDED.enabled
                    THEN 1 ELSE 0 END,
           updated_at = EXCLUDED.updated_at`,
        [input.communityGroupId, input.enabled, input.now],
      );

      let cancelledOpenSpawn = false;
      if (!input.enabled) {
        await client.query(
          `UPDATE competitive_spawn_group_settings
           SET incense_until = NULL,
               updated_at = $2
           WHERE community_group_id = $1`,
          [input.communityGroupId, input.now],
        );

        const cancelled = await client.query(
          `UPDATE competitive_spawns
           SET status = 'CANCELLED', resolved_at = $2
           WHERE community_group_id = $1
             AND status = 'OPEN'`,
          [input.communityGroupId, input.now],
        );
        cancelledOpenSpawn = (cancelled.rowCount ?? 0) > 0;

        await client.query(
          `UPDATE competitive_spawn_activity_state
           SET progress_milli = 0,
               target_roll = NULL,
               last_activity_at = NULL,
               last_player_id = NULL,
               sender_streak = 0,
               updated_at = $2
           WHERE community_group_id = $1`,
          [input.communityGroupId, input.now],
        );

        await client.query(
          `UPDATE competitive_spawn_activity_senders
           SET active_at = to_timestamp(0)
           WHERE community_group_id = $1`,
          [input.communityGroupId],
        );
      }

      return { enabled: input.enabled, cancelledOpenSpawn };
    });
  }

  public async incenseUntil(communityGroupId: string, now: Date): Promise<Date | null> {
    const result = await this.pool.query<{ incense_until: Date | null }>(
      `SELECT CASE
                WHEN incense_until > $2 THEN incense_until
                ELSE NULL
              END AS incense_until
       FROM competitive_spawn_group_settings
       WHERE community_group_id = $1`,
      [communityGroupId, now],
    );
    return result.rows[0]?.incense_until ?? null;
  }

  public async setIncense(input: {
    readonly communityGroupId: string;
    readonly incenseUntil: Date | null;
    readonly now: Date;
  }): Promise<Date | null> {
    const result = await this.pool.query<{ incense_until: Date | null }>(
      `UPDATE competitive_spawn_group_settings
       SET incense_until = $2,
           revision = revision + CASE
             WHEN incense_until IS DISTINCT FROM $2 THEN 1
             ELSE 0
           END,
           updated_at = $3
       WHERE community_group_id = $1
       RETURNING incense_until`,
      [input.communityGroupId, input.incenseUntil, input.now],
    );
    return result.rows[0]?.incense_until ?? null;
  }
}
