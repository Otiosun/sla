import type { Pool } from "pg";
import { withTransaction } from "../db/transaction.js";

export interface NarratorBattleCleanupResult {
  readonly battleId: string;
  readonly encounterId: string;
}

export class PostgresNarratorBattleCleanup {
  public constructor(private readonly pool: Pool) {}

  public async cleanupForPlayer(playerId: string): Promise<NarratorBattleCleanupResult | null> {
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ battle_id: string; encounter_id: string }>(
        `SELECT battle.id::text AS battle_id,
                encounter.id::text AS encounter_id
         FROM encounters encounter
         JOIN battles battle ON battle.encounter_id = encounter.id
         WHERE encounter.player_id = $1
           AND encounter.status = 'IN_BATTLE'
           AND battle.battle_type = 'WILD'
           AND battle.status = 'CANCELLED'
         ORDER BY battle.updated_at DESC, battle.id
         LIMIT 1
         FOR UPDATE OF encounter`,
        [playerId],
      );
      const row = found.rows[0];
      if (row === undefined) return null;

      await client.query(
        `UPDATE encounter_wild_snapshots
         SET status = 'FLED', updated_at = now()
         WHERE encounter_id = $1
           AND status = 'ACTIVE'`,
        [row.encounter_id],
      );
      const closed = await client.query(
        `UPDATE encounters
         SET status = 'CLOSED',
             revision = revision + 1,
             updated_at = now(),
             closed_at = COALESCE(closed_at, now())
         WHERE id = $1
           AND status = 'IN_BATTLE'`,
        [row.encounter_id],
      );
      if (closed.rowCount !== 1) {
        throw new Error("Narrator cancelled-battle encounter cleanup lost its locked encounter");
      }
      return { battleId: row.battle_id, encounterId: row.encounter_id };
    });
  }
}
