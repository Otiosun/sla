import type { PoolClient } from "pg";
import type { BattleState } from "../../modules/battle/contracts.js";

const MAJOR_STATUS_KEYS = ["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"] as const;

export async function persistPlayerBattleState(
  client: PoolClient,
  battleId: string,
  state: BattleState,
): Promise<void> {
  if (state.battleId !== battleId) {
    throw new Error("Battle player-state write-back received a mismatched battle id");
  }

  const playerIdBySideNo = new Map<number, string>();
  for (const side of state.sides) {
    if (side.controllerKind !== "PLAYER") continue;
    if (side.playerId === null) {
      throw new Error("Player-controlled battle side is missing its player id");
    }
    playerIdBySideNo.set(side.sideNo, side.playerId);
  }

  for (const combatant of state.combatants) {
    if (combatant.participantKind !== "PLAYER_POKEMON") continue;
    if (combatant.pokemonInstanceId === null) {
      throw new Error("Player battle combatant is missing its Pokemon instance id");
    }

    const playerId = playerIdBySideNo.get(combatant.sideNo);
    if (playerId === undefined) {
      throw new Error("Player battle combatant is not attached to a player-controlled side");
    }

    const participant = await client.query<{ pokemon_instance_id: string | null }>(
      `SELECT participant.pokemon_instance_id
       FROM battle_participants participant
       JOIN battle_sides side
         ON side.id = participant.battle_side_id
        AND side.battle_id = participant.battle_id
       WHERE participant.id = $1
         AND participant.battle_id = $2
         AND participant.participant_kind = 'PLAYER_POKEMON'
         AND side.player_id = $3`,
      [combatant.participantId, battleId, playerId],
    );
    if (participant.rows[0]?.pokemon_instance_id !== combatant.pokemonInstanceId) {
      throw new Error("Battle player-state write-back participant ownership mismatch");
    }

    const pokemonUpdated = await client.query(
      `UPDATE pokemon_instances
       SET current_hp = $3,
           revision = revision + 1,
           updated_at = now()
       WHERE id = $1
         AND owner_player_id = $2
         AND status = 'ACTIVE'`,
      [combatant.pokemonInstanceId, playerId, combatant.currentHp],
    );
    if (pokemonUpdated.rowCount !== 1) {
      throw new Error("Battle player-state write-back could not update the owned Pokemon");
    }

    for (const move of combatant.moves) {
      const moveUpdated = await client.query(
        `UPDATE pokemon_move_slots
         SET pp_current = $4
         WHERE pokemon_instance_id = $1
           AND slot_no = $2
           AND move_id = $3`,
        [combatant.pokemonInstanceId, move.slotNo, move.moveId, move.ppCurrent],
      );
      if (moveUpdated.rowCount !== 1) {
        throw new Error("Battle player-state write-back found a stale Pokemon move slot");
      }
    }

    await client.query(
      `DELETE FROM pokemon_persistent_conditions
       WHERE pokemon_instance_id = $1
         AND condition_key = ANY($2::text[])`,
      [combatant.pokemonInstanceId, MAJOR_STATUS_KEYS],
    );

    if (combatant.majorStatus !== null) {
      await client.query(
        `INSERT INTO pokemon_persistent_conditions(
           pokemon_instance_id, condition_key, source_type, source_id, data
         ) VALUES ($1, $2, 'BATTLE', $3, $4::jsonb)`,
        [
          combatant.pokemonInstanceId,
          combatant.majorStatus.key,
          battleId,
          JSON.stringify({ counter: combatant.majorStatus.counter }),
        ],
      );
    }
  }
}
