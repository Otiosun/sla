import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";

export interface ClaimReceptionFirstWelcomeInput {
  readonly groupId: string;
  readonly playerId: PlayerId;
}

export class PostgresReceptionPresenceRepository {
  public constructor(private readonly pool: Pool) {}

  public async needsFirstWelcome(input: ClaimReceptionFirstWelcomeInput): Promise<boolean> {
    const result = await this.pool.query<{ needs_welcome: boolean }>(
      `SELECT last_welcome_at IS NULL AS needs_welcome
       FROM community_member_presence
       WHERE group_id = $1 AND player_id = $2`,
      [input.groupId, input.playerId],
    );
    return result.rows[0]?.needs_welcome ?? true;
  }

  public async claimFirstWelcome(input: ClaimReceptionFirstWelcomeInput): Promise<boolean> {
    const result = await this.pool.query<{ claimed: number }>(
      `INSERT INTO community_member_presence(
         group_id,
         player_id,
         presence_generation,
         first_seen_at,
         last_seen_at,
         last_welcome_at
       )
       VALUES ($1, $2, 0, now(), now(), now())
       ON CONFLICT (group_id, player_id) DO UPDATE
       SET last_seen_at = now(),
           last_welcome_at = now()
       WHERE community_member_presence.last_welcome_at IS NULL
       RETURNING 1 AS claimed`,
      [input.groupId, input.playerId],
    );
    return result.rows[0]?.claimed === 1;
  }
}
