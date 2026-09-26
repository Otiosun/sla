import type { Pool } from "pg";
import {
  DEFAULT_PLAYER_PORTAL_PROFILE_CUSTOMIZATION,
  type PlayerPortalProfileCustomization,
  type PlayerPortalProfileCustomizationRepository,
  PlayerPortalProfileCustomizationSchema,
} from "../../modules/player-portal/profile-customization-service.js";
import type { PlayerId } from "../../shared-kernel/ids.js";

function parseStoredCustomization(value: unknown): PlayerPortalProfileCustomization {
  const parsed = PlayerPortalProfileCustomizationSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_PLAYER_PORTAL_PROFILE_CUSTOMIZATION };
}

export class PostgresPlayerPortalProfileCustomizationRepository
  implements PlayerPortalProfileCustomizationRepository
{
  public constructor(private readonly pool: Pool) {}

  public async read(playerId: PlayerId): Promise<PlayerPortalProfileCustomization> {
    const result = await this.pool.query<{ customization: unknown }>(
      `SELECT metadata -> 'hubCustomization' AS customization
       FROM player_profiles
       WHERE player_id = $1`,
      [playerId],
    );

    const row = result.rows[0];
    if (row === undefined || row.customization === null) {
      return { ...DEFAULT_PLAYER_PORTAL_PROFILE_CUSTOMIZATION };
    }
    return parseStoredCustomization(row.customization);
  }

  public async update(
    playerId: PlayerId,
    customization: PlayerPortalProfileCustomization,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE player_profiles
       SET metadata = jsonb_set(
             metadata,
             '{hubCustomization}',
             $2::jsonb,
             TRUE
           ),
           revision = revision + 1,
           updated_at = now()
       WHERE player_id = $1`,
      [playerId, JSON.stringify(customization)],
    );
    return result.rowCount === 1;
  }
}
