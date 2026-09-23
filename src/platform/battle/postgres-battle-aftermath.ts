import type { Pool, PoolClient } from "pg";
import { type BattleState, BattleStateSchema } from "../../modules/battle/contracts.js";
import type { BattleAftermathPort, BattleAftermathResult } from "../../modules/battle/runtime.js";
import { RulesetConfigSchema } from "../../modules/catalog/contracts.js";
import { WorldAreaConfigSchema } from "../../modules/catalog/world-contracts.js";
import { withTransaction } from "../db/transaction.js";

interface PlayerLocationRow {
  readonly area_id: string;
  readonly region_id: string;
}

interface SafePointRow {
  readonly area_id: string;
  readonly data: unknown;
}

async function relocatePlayer(
  client: PoolClient,
  playerId: string,
  contentReleaseId: string,
): Promise<boolean> {
  const location = await client.query<PlayerLocationRow>(
    `SELECT location.area_id, area.region_id
     FROM player_locations location
     JOIN areas area ON area.id = location.area_id
     WHERE location.player_id = $1
     FOR UPDATE OF location`,
    [playerId],
  );
  const current = location.rows[0];
  if (current === undefined) {
    throw new Error("Defeated player has no persisted world location");
  }

  const candidates = await client.query<SafePointRow>(
    `SELECT area.id AS area_id, revision.data
     FROM areas area
     JOIN area_revisions revision
       ON revision.area_id = area.id
      AND revision.content_release_id = $1
     WHERE area.region_id = $2
       AND revision.active = TRUE
     ORDER BY area.id`,
    [contentReleaseId, current.region_id],
  );

  const safePoints = candidates.rows
    .map((row) => {
      const parsed = WorldAreaConfigSchema.safeParse(row.data);
      if (!parsed.success) {
        throw new Error(`Published safe-point candidate ${row.area_id} has invalid world config`);
      }
      return { areaId: row.area_id, config: parsed.data };
    })
    .filter((entry) => entry.config.safePoint)
    .sort(
      (left, right) =>
        left.config.relocationPriority - right.config.relocationPriority ||
        left.areaId.localeCompare(right.areaId),
    );

  const destination = safePoints[0];
  if (destination === undefined) {
    throw new Error("Defeat policy requires relocation but no active safe point exists in region");
  }
  if (destination.areaId === current.area_id) return false;

  const moved = await client.query(
    `UPDATE player_locations
     SET area_id = $2,
         entered_at = now(),
         revision = revision + 1
     WHERE player_id = $1`,
    [playerId, destination.areaId],
  );
  if (moved.rowCount !== 1) {
    throw new Error("Defeat relocation lost the locked player location row");
  }
  return true;
}

export class PostgresBattleAftermath implements BattleAftermathPort {
  public constructor(private readonly pool: Pool) {}

  public async runOnce(limit: number): Promise<readonly { battleId: string; error?: unknown }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Battle aftermath batch limit must be a positive safe integer");
    }
    const pending = await this.pool.query<{ battle_id: string; state: unknown }>(
      `SELECT task.battle_id, snapshot.state
       FROM battle_defeat_aftermath task
       JOIN battle_state_snapshots snapshot
         ON snapshot.battle_id = task.battle_id AND snapshot.version = task.battle_version
       WHERE task.completed_at IS NULL ORDER BY task.created_at, task.battle_id LIMIT $1`,
      [limit],
    );
    const outcomes: { battleId: string; error?: unknown }[] = [];
    for (const row of pending.rows) {
      try {
        await this.applyDefeat(BattleStateSchema.parse(row.state));
        outcomes.push({ battleId: row.battle_id });
      } catch (error) {
        outcomes.push({ battleId: row.battle_id, error });
      }
    }
    return outcomes;
  }

  public async applyDefeat(state: BattleState): Promise<BattleAftermathResult> {
    if (state.status !== "LOST") return { relocatedPlayerIds: [] };

    return withTransaction(
      this.pool,
      async (client) => {
        const task = await client.query<{ battle_version: string; completed_at: Date | null }>(
          `SELECT battle_version, completed_at FROM battle_defeat_aftermath
           WHERE battle_id = $1 FOR UPDATE`,
          [state.battleId],
        );
        const delivery = task.rows[0];
        if (delivery !== undefined) {
          if (Number(delivery.battle_version) !== state.version) {
            throw new Error("Defeat aftermath snapshot version conflicts with durable delivery");
          }
          if (delivery.completed_at !== null) return { relocatedPlayerIds: [] };
        }
        const ruleset = await client.query<{ config: unknown }>(
          `SELECT config FROM rulesets WHERE id = $1`,
          [state.rulesetId],
        );
        const row = ruleset.rows[0];
        if (row === undefined) throw new Error("Pinned defeat ruleset no longer exists");
        const parsed = RulesetConfigSchema.safeParse(row.config);
        if (!parsed.success) throw new Error("Pinned defeat ruleset has invalid config");

        // Engine-contract v1 policy: defeat never debits money and always returns losing players
        // to the highest-priority active safe point in their current region. Because the ruleset
        // schema requires automaticMoneyLoss=false, replays can safely retry this aftermath.
        if (parsed.data.defeat.automaticMoneyLoss !== false) {
          throw new Error("Battle Engine v1 forbids automatic money loss on defeat");
        }

        const owners = await client.query<{ player_id: string }>(
          `SELECT DISTINCT controller.player_id
           FROM battle_participant_controllers controller
           JOIN battle_participants participant ON participant.id = controller.participant_id
           JOIN battle_sides side ON side.id = participant.battle_side_id
           WHERE controller.battle_id = $1 AND controller.kind = 'PLAYER'
             AND side.side_no = ANY($2::smallint[])
           ORDER BY controller.player_id`,
          [
            state.battleId,
            state.sides.filter((side) => side.result === "LOST").map((side) => side.sideNo),
          ],
        );
        const playerIds =
          delivery === undefined
            ? state.sides
                .filter((side) => side.controllerKind === "PLAYER" && side.result === "LOST")
                .flatMap((side) => (side.playerId === null ? [] : [side.playerId]))
            : owners.rows.map((row) => row.player_id);
        const relocated: string[] = [];
        for (const playerId of [...new Set(playerIds)].sort()) {
          if (await relocatePlayer(client, playerId, state.contentReleaseId)) {
            relocated.push(playerId);
          }
        }
        if (delivery !== undefined) {
          await client.query(
            `UPDATE battle_defeat_aftermath SET completed_at = now() WHERE battle_id = $1`,
            [state.battleId],
          );
        }
        return { relocatedPlayerIds: relocated };
      },
      { isolationLevel: "READ COMMITTED" },
    );
  }
}
