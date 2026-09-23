import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { BattleStateSchema } from "../../modules/battle/contracts.js";
import type {
  BattleParticipantController,
  BattleParticipantControllerRepository,
} from "../../modules/battle/participant-controller.js";
import { requiredActionParticipants } from "../../modules/battle/resolver.js";
import { refreshTurnWindowRequirements } from "../../modules/battle/turn-window.js";
import { withTransaction } from "../db/transaction.js";
import { loadAggregateById } from "./postgres-battle-turn-window-repository.js";

type InitializeInput = Parameters<BattleParticipantControllerRepository["initialize"]>[0];
type TransitionInput = Parameters<BattleParticipantControllerRepository["transition"]>[0];
interface ControllerRow {
  participant_id: string;
  battle_id: string;
  kind: BattleParticipantController["kind"];
  player_id: string | null;
  admin_principal_id: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

function parse(row: ControllerRow): BattleParticipantController {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Controller revision is outside JS safe range");
  }
  return {
    participantId: row.participant_id,
    battleId: row.battle_id,
    kind: row.kind,
    playerId: row.player_id,
    adminPrincipalId: row.admin_principal_id,
    revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadParticipantControllersInTransaction(
  client: PoolClient,
  battleId: string,
): Promise<readonly BattleParticipantController[]> {
  const result = await client.query<ControllerRow>(
    "SELECT * FROM battle_participant_controllers WHERE battle_id=$1 ORDER BY participant_id",
    [battleId],
  );
  return result.rows.map(parse);
}

async function recordEvent(
  client: PoolClient,
  current: BattleParticipantController,
  previous: BattleParticipantController | null,
  actor: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO battle_participant_controller_events(
       id, battle_id, participant_id, old_kind, old_player_id, old_admin_principal_id,
       new_kind, new_player_id, new_admin_principal_id, previous_revision,
       resulting_revision, actor_admin_principal_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      randomUUID(),
      current.battleId,
      current.participantId,
      previous?.kind ?? null,
      previous?.playerId ?? null,
      previous?.adminPrincipalId ?? null,
      current.kind,
      current.playerId,
      current.adminPrincipalId,
      previous?.revision ?? null,
      current.revision,
      actor,
    ],
  );
}

export async function initializeParticipantControllerInTransaction(
  client: PoolClient,
  input: InitializeInput,
): Promise<BattleParticipantController> {
  const inserted = await client.query<ControllerRow>(
    `INSERT INTO battle_participant_controllers(participant_id,battle_id,kind,player_id,admin_principal_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (participant_id) DO NOTHING RETURNING *`,
    [input.participantId, input.battleId, input.kind, input.playerId, input.adminPrincipalId],
  );
  const row = inserted.rows[0];
  if (row !== undefined) {
    const current = parse(row);
    await recordEvent(client, current, null, input.adminPrincipalId);
    return current;
  }
  const existing = await client.query<ControllerRow>(
    "SELECT * FROM battle_participant_controllers WHERE participant_id = $1",
    [input.participantId],
  );
  const current = existing.rows[0];
  if (current === undefined || current.battle_id !== input.battleId) {
    throw new Error("Controller initialization conflicts with participant battle");
  }
  const initialized = await client.query(
    `SELECT 1 FROM battle_participant_controller_events
         WHERE participant_id = $1 AND resulting_revision = 0
         AND new_kind = $2 AND new_player_id IS NOT DISTINCT FROM $3::uuid
         AND new_admin_principal_id IS NOT DISTINCT FROM $4::uuid`,
    [input.participantId, input.kind, input.playerId, input.adminPrincipalId],
  );
  if (initialized.rowCount !== 1) {
    throw new Error("Controller initialization conflicts with original identity");
  }
  // Initialization retries never reset a controller that has since transitioned.
  return parse(current);
}

export class PostgresBattleParticipantControllerRepository
  implements BattleParticipantControllerRepository
{
  public constructor(private readonly pool: Pool) {}

  public async get(participantId: string): Promise<BattleParticipantController | null> {
    const result = await this.pool.query<ControllerRow>(
      "SELECT * FROM battle_participant_controllers WHERE participant_id = $1",
      [participantId],
    );
    return result.rows[0] === undefined ? null : parse(result.rows[0]);
  }

  public async listByBattle(battleId: string): Promise<readonly BattleParticipantController[]> {
    const result = await this.pool.query<ControllerRow>(
      "SELECT * FROM battle_participant_controllers WHERE battle_id = $1 ORDER BY participant_id",
      [battleId],
    );
    return result.rows.map(parse);
  }

  public async initialize(input: InitializeInput): Promise<BattleParticipantController> {
    return withTransaction(this.pool, async (client) => {
      return initializeParticipantControllerInTransaction(client, input);
    });
  }

  public async transition(input: TransitionInput): Promise<BattleParticipantController | null> {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      (input.kind === "NARRATOR"
        ? input.adminPrincipalId === null
        : input.adminPrincipalId !== null)
    ) {
      return null;
    }
    return withTransaction(this.pool, async (client) => {
      // Resolution locks battle then window; preserve that order and prevent version races.
      const battle = await client.query(
        `SELECT b.id FROM battles b
         JOIN battle_participant_controllers c ON c.battle_id = b.id
         WHERE c.participant_id = $1 FOR UPDATE OF b`,
        [input.participantId],
      );
      if (battle.rowCount !== 1) return null;
      // Lock the same window row as submission/resolution before changing its controller.
      const window = await client.query<{ id: string; status: string }>(
        `SELECT w.id, w.status FROM battle_turn_windows w
         JOIN battles b ON b.id = w.battle_id AND b.version = w.battle_version
           AND b.turn_number = w.turn_number
         JOIN battle_participant_controllers c ON c.battle_id = b.id
         WHERE c.participant_id = $1 AND b.status = 'ACTIVE'
         FOR UPDATE OF w`,
        [input.participantId],
      );
      if (window.rows[0]?.status !== "COLLECTING") return null;
      const existing = await client.query<ControllerRow>(
        "SELECT * FROM battle_participant_controllers WHERE participant_id = $1 FOR UPDATE",
        [input.participantId],
      );
      const row = existing.rows[0];
      if (row === undefined) return null;
      const previous = parse(row);
      if (
        previous.revision !== input.expectedRevision ||
        previous.kind === "PLAYER" ||
        previous.kind === input.kind
      )
        return null;
      const committed = await client.query(
        `SELECT 1 FROM battle_turn_submissions WHERE turn_window_id = $1
         AND actor_participant_id = $2 AND status IN ('ACTIVE', 'COMMITTED')`,
        [window.rows[0].id, input.participantId],
      );
      if (committed.rowCount !== 0) return null;
      // Refresh the human snapshot in the same transaction as controller state/history.
      const aggregate = await loadAggregateById(client, window.rows[0].id, false);
      let refreshed = null;
      if (aggregate?.window.requiredControllers !== undefined) {
        const snapshot = await client.query<{ state: unknown }>(
          "SELECT state FROM battle_state_snapshots WHERE battle_id=$1 AND version=$2",
          [previous.battleId, aggregate.window.battleVersion],
        );
        const parsed = BattleStateSchema.safeParse(snapshot.rows[0]?.state);
        if (!parsed.success) return null;
        const state = parsed.data;
        if (
          state.battleId !== previous.battleId ||
          state.version !== aggregate.window.battleVersion ||
          state.turnNumber !== aggregate.window.turnNumber ||
          state.status !== "ACTIVE"
        )
          return null;
        const side = state.sides.find((s) => s.participantIds.includes(input.participantId));
        if (side === undefined) return null;
        const required = requiredActionParticipants(state).some(
          (actor) => actor.participantId === input.participantId,
        );
        const requirements = aggregate.window.requiredControllers.filter(
          (r) => r.participantId !== input.participantId,
        );
        if (input.kind === "NARRATOR" && required)
          requirements.push({
            participantId: input.participantId,
            kind: "NARRATOR",
            playerId: null,
            adminPrincipalId: input.adminPrincipalId,
            sideNo: side.sideNo,
            revision: input.expectedRevision + 1,
          });
        const result = refreshTurnWindowRequirements(aggregate, requirements, new Date());
        if (!result.ok) return null;
        refreshed = result.value;
      }
      const updated = await client.query<ControllerRow>(
        `UPDATE battle_participant_controllers
         SET kind = $2, admin_principal_id = $3, revision = revision + 1, updated_at = now()
         WHERE participant_id = $1 AND revision = $4 RETURNING *`,
        [input.participantId, input.kind, input.adminPrincipalId, input.expectedRevision],
      );
      if (updated.rows[0] === undefined) return null;
      const current = parse(updated.rows[0]);
      if (refreshed !== null) {
        await client.query(
          `UPDATE battle_turn_windows SET required_controllers=$2::jsonb,
          status=$3,locked_at=$4,revision=$5 WHERE id=$1`,
          [
            refreshed.window.id,
            JSON.stringify(refreshed.window.requiredControllers),
            refreshed.window.status,
            refreshed.window.lockedAt,
            refreshed.window.revision,
          ],
        );
      }
      await recordEvent(
        client,
        current,
        previous,
        input.adminPrincipalId ?? previous.adminPrincipalId,
      );
      return current;
    });
  }
}
