import type { Pool, PoolClient } from "pg";
import { type BattleState, BattleStateSchema } from "../../modules/battle/contracts.js";
import type { BattleAftermathPort, BattleAftermathResult } from "../../modules/battle/runtime.js";
import { RulesetConfigSchema } from "../../modules/catalog/contracts.js";
import { WorldAreaConfigSchema } from "../../modules/catalog/world-contracts.js";
import { parsePlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";
import { settleExpeditionBattle } from "../exploration/expedition-blackout.js";
import { worldRepositoryWithinTransaction } from "../world/postgres-world-repository.js";

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
  expeditionBattleId?: string,
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

  if (expeditionBattleId !== undefined) {
    const id = parsePlayerId(playerId);
    if (!id.ok) throw new Error("Invalid blackout player");
    const published = await client.query(
      `SELECT 1 FROM content_releases release JOIN region_revisions region ON region.content_release_id=release.id
       WHERE release.id=$1 AND release.status='PUBLISHED' AND region.region_id=$2 AND region.active FOR SHARE`,
      [contentReleaseId, current.region_id],
    );
    const destination =
      published.rowCount === 1
        ? await worldRepositoryWithinTransaction(client).transaction(async (world) => {
            const areas = new Map(
              (await world.areasInRegion(contentReleaseId, current.region_id))
                .filter((area) => area.active)
                .map((area) => [area.areaId, area]),
            );
            if (!areas.has(current.area_id)) return undefined;
            const unlocks = new Set(await world.activeUnlockKeys(id.value));
            const visited = new Set([current.area_id]);
            let frontier = [current.area_id];
            while (frontier.length > 0) {
              const safe = frontier.sort().find((areaId) => areas.get(areaId)?.config.safePoint);
              if (safe) return safe;
              const next: string[] = [];
              for (const areaId of frontier) {
                for (const edge of await world.connectionsFrom(contentReleaseId, areaId)) {
                  if (
                    !edge.active ||
                    !areas.has(edge.toAreaId) ||
                    visited.has(edge.toAreaId) ||
                    !edge.accessRule.requiredUnlockKeys.every((key) => unlocks.has(key))
                  )
                    continue;
                  visited.add(edge.toAreaId);
                  next.push(edge.toAreaId);
                }
              }
              frontier = next;
            }
            return undefined;
          })
        : undefined;
    if (destination === undefined) {
      await client.query(
        `UPDATE solo_expedition_receipts SET result=result || '{"blackoutNeedsStaff":true}'::jsonb
         WHERE player_id=$1 AND idempotency_key=$2`,
        [playerId, "battle-blackout:" + expeditionBattleId],
      );
      return false;
    }
    return movePlayer(client, playerId, current.area_id, destination);
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
  return movePlayer(client, playerId, current.area_id, destination.areaId);
}

async function movePlayer(
  client: PoolClient,
  playerId: string,
  currentArea: string,
  destination: string,
): Promise<boolean> {
  if (destination === currentArea) return false;

  const moved = await client.query(
    `UPDATE player_locations
     SET area_id = $2,
         entered_at = now(),
         revision = revision + 1
     WHERE player_id = $1`,
    [playerId, destination],
  );
  if (moved.rowCount !== 1) {
    throw new Error("Defeat relocation lost the locked player location row");
  }
  return true;
}

export class PostgresBattleAftermath implements BattleAftermathPort {
  public constructor(
    private readonly pool: Pool,
    private readonly expeditionBlackoutEnabled = false,
    private readonly operationalExpeditionPlayers?: ReadonlySet<string>,
    private readonly permitsBattle?: (battleId: string) => Promise<boolean>,
  ) {}

  public async runOnce(limit: number): Promise<readonly { battleId: string; error?: unknown }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Battle aftermath batch limit must be a positive safe integer");
    }
    const pending: { battle_id: string; state: unknown }[] = [];
    for (let offset = 0; pending.length < limit; offset += limit) {
      const batch = await this.pool.query<{ battle_id: string; state: unknown }>(
        `SELECT task.battle_id, snapshot.state
       FROM battle_defeat_aftermath task
       JOIN battle_state_snapshots snapshot
         ON snapshot.battle_id = task.battle_id AND snapshot.version = task.battle_version
       WHERE task.completed_at IS NULL ORDER BY task.created_at, task.battle_id LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      for (const row of batch.rows) {
        if (!this.permitsBattle || (await this.permitsBattle(row.battle_id))) pending.push(row);
        if (pending.length === limit) break;
      }
      if (!this.permitsBattle || batch.rows.length < limit) break;
    }
    const outcomes: { battleId: string; error?: unknown }[] = [];
    for (const row of pending) {
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
    if (this.permitsBattle && !(await this.permitsBattle(state.battleId)))
      return { relocatedPlayerIds: [] };
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
          let blackout = false;
          if (this.expeditionBlackoutEnabled) {
            blackout = await settleExpeditionBattle(
              client,
              playerId,
              state.battleId,
              true,
              this.operationalExpeditionPlayers,
            );
          }
          if (
            await relocatePlayer(
              client,
              playerId,
              state.contentReleaseId,
              blackout ? state.battleId : undefined,
            )
          ) {
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
