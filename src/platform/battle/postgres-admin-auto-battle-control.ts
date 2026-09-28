import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/transaction.js";

interface PlayerControllerRow {
  readonly participant_id: string;
  readonly player_id: string;
  readonly revision: string;
}

interface WindowRow {
  readonly id: string;
  readonly status: string;
  readonly revision: string;
  readonly required_controllers: unknown;
}

export class PostgresAdminAutoBattleControl {
  public constructor(private readonly pool: Pool) {}

  public async automatePlayers(battleId: string): Promise<{ readonly automated: number }> {
    return withTransaction(this.pool, async (client) => {
      const root = await client.query<{ version: string; status: string }>(
        "SELECT version::text, status FROM battles WHERE id=$1 FOR UPDATE",
        [battleId],
      );
      const battle = root.rows[0];
      if (battle === undefined) throw new Error("Auto battle root was not found");
      if (battle.status !== "ACTIVE") throw new Error("Auto battle is not active");

      const windows = await client.query<WindowRow>(
        `SELECT id,status,revision::text,required_controllers
         FROM battle_turn_windows
         WHERE battle_id=$1 AND battle_version=$2
         FOR UPDATE`,
        [battleId, battle.version],
      );
      const window = windows.rows[0];
      if (window === undefined) throw new Error("Auto battle turn window was not found");
      if (window.required_controllers === null) {
        throw new Error("Auto battle requires controller-backed turn windows");
      }

      const submitted = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM battle_turn_submissions
         WHERE turn_window_id=$1 AND status IN ('ACTIVE','COMMITTED')`,
        [window.id],
      );
      if ((submitted.rows[0]?.n ?? 0) !== 0) {
        throw new Error("Auto battle cannot take over after a turn action was submitted");
      }

      const controllers = await client.query<PlayerControllerRow>(
        `SELECT participant_id,player_id,revision::text
         FROM battle_participant_controllers
         WHERE battle_id=$1 AND kind='PLAYER'
         ORDER BY participant_id
         FOR UPDATE`,
        [battleId],
      );

      if (controllers.rows.length === 0) {
        if (window.status === "LOCKED" && JSON.stringify(window.required_controllers) === "[]") {
          return { automated: 0 };
        }
        throw new Error("Auto battle has no player controllers to automate");
      }
      if (window.status !== "COLLECTING") {
        throw new Error("Auto battle takeover requires a collecting turn window");
      }

      for (const controller of controllers.rows) {
        const previousRevision = Number(controller.revision);
        if (!Number.isSafeInteger(previousRevision) || previousRevision < 0) {
          throw new Error("Auto battle controller revision is invalid");
        }
        const updated = await client.query<{ revision: string }>(
          `UPDATE battle_participant_controllers
           SET kind='AUTO',
               player_id=NULL,
               admin_principal_id=NULL,
               revision=revision+1,
               updated_at=now()
           WHERE participant_id=$1 AND battle_id=$2 AND kind='PLAYER' AND revision=$3
           RETURNING revision::text`,
          [controller.participant_id, battleId, previousRevision],
        );
        const resultingRevision = updated.rows[0]?.revision;
        if (resultingRevision === undefined) {
          throw new Error("Auto battle controller changed concurrently");
        }
        await client.query(
          `INSERT INTO battle_participant_controller_events(
             id,battle_id,participant_id,
             old_kind,old_player_id,old_admin_principal_id,
             new_kind,new_player_id,new_admin_principal_id,
             previous_revision,resulting_revision,actor_admin_principal_id
           ) VALUES ($1,$2,$3,'PLAYER',$4,NULL,'AUTO',NULL,NULL,$5,$6,NULL)`,
          [
            randomUUID(),
            battleId,
            controller.participant_id,
            controller.player_id,
            previousRevision,
            resultingRevision,
          ],
        );
      }

      const changed = await client.query(
        `UPDATE battle_turn_windows
         SET required_controllers='[]'::jsonb,
             status='LOCKED',
             locked_at=COALESCE(locked_at,now()),
             revision=revision+1
         WHERE id=$1 AND status='COLLECTING'`,
        [window.id],
      );
      if (changed.rowCount !== 1) {
        throw new Error("Auto battle turn window changed concurrently");
      }

      return { automated: controllers.rows.length };
    });
  }
}
