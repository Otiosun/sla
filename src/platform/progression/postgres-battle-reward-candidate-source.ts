import type { Pool } from "pg";
import type { BattleRewardCandidateSource } from "../../modules/progression/battle-reward-worker.js";

export class PostgresBattleRewardCandidateSource implements BattleRewardCandidateSource {
  public constructor(private readonly pool: Pool) {}

  public async listPendingBattleIds(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Battle reward candidate limit must be a positive safe integer");
    }

    const result = await this.pool.query<{ id: string }>(
      `SELECT battle.id
       FROM battles battle
       WHERE battle.status='WON'
         AND battle.battle_type IN ('WILD','NPC')
         AND NOT EXISTS (
           SELECT 1
           FROM battle_reward_claims claim
           WHERE claim.battle_id=battle.id
         )
       ORDER BY battle.updated_at,battle.id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }
}
