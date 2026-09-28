import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import type { PveBattleStartRollbackPort } from "../../modules/battle/pve-battle-start.js";
import { withTransaction } from "../db/transaction.js";

export class PostgresPveBattleStartRollback implements PveBattleStartRollbackPort {
  public constructor(private readonly pool: Pool) {}

  public async rollback(input: {
    readonly playerId: PlayerId;
    readonly battleId: string;
  }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ encounter_id: string }>(
        `SELECT encounter.id::text AS encounter_id
         FROM battles battle
         JOIN encounters encounter ON encounter.id = battle.encounter_id
         WHERE battle.id = $1
           AND battle.battle_type = 'WILD'
           AND battle.status = 'CREATED'
           AND encounter.player_id = $2
           AND encounter.status = 'IN_BATTLE'
         FOR UPDATE OF battle, encounter`,
        [input.battleId, input.playerId],
      );
      const row = found.rows[0];
      if (row === undefined) return false;

      const cancelled = await client.query(
        `UPDATE battles
         SET status = 'CANCELLED',
             updated_at = now(),
             ended_at = now()
         WHERE id = $1
           AND status = 'CREATED'`,
        [input.battleId],
      );
      if (cancelled.rowCount !== 1) {
        throw new Error("PVE initialization rollback lost its locked battle");
      }

      await client.query(
        `UPDATE battle_turn_windows
         SET status = 'CANCELLED',
             locked_at = COALESCE(locked_at, now()),
             revision = revision + 1
         WHERE battle_id = $1
           AND status IN ('COLLECTING', 'LOCKED')`,
        [input.battleId],
      );

      await client.query(
        `UPDATE encounter_wild_snapshots
         SET status = 'FLED',
             updated_at = now()
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
        throw new Error("PVE initialization rollback lost its locked encounter");
      }

      return true;
    });
  }
}
