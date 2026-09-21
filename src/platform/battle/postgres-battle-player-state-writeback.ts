import type { PoolClient } from "pg";
import type { BattleState } from "../../modules/battle/contracts.js";

const MAJOR_STATUS_KEYS = ["BURN", "POISON", "BAD_POISON", "PARALYSIS", "SLEEP", "FREEZE"] as const;

interface PersistedPlayerParticipantRow {
  readonly pokemon_instance_id: string;
  readonly owner_player_id: string | null;
  readonly status: string;
}

export async function persistPlayerBattleState(
  client: PoolClient,
  battleId: string,
  state: BattleState,
): Promise<void> {
  if (state.battleId !== battleId) {
    throw new Error("Battle player-state write-back received a mismatched battle id");
  }

  for (const combatant of state.combatants) {
    if (combatant.participantKind !== "PLAYER_POKEMON") continue;
    if (combatant.pokemonInstanceId === null) {
      throw new Error("Player battle combatant is missing its Pokemon instance id");
    }

    // Ownership is resolved from the frozen battle participant -> Pokemon relation.
    // Do not infer it from battle_sides.player_id: advanced PVE can have multiple
    // real owners allied on one side, and controllers can transition to AUTO/NARRATOR.
    const participant = await client.query<PersistedPlayerParticipantRow>(
      `SELECT participant.pokemon_instance_id,
              pokemon.owner_player_id,
              pokemon.status
       FROM battle_participants participant
       JOIN pokemon_instances pokemon
         ON pokemon.id = participant.pokemon_instance_id
       WHERE participant.id = $1
         AND participant.battle_id = $2
         AND participant.participant_kind = 'PLAYER_POKEMON'`,
      [combatant.participantId, battleId],
    );
    const persisted = participant.rows[0];
    if (
      persisted === undefined ||
      persisted.pokemon_instance_id !== combatant.pokemonInstanceId ||
      persisted.owner_player_id === null
    ) {
      throw new Error("Battle player-state write-back participant ownership mismatch");
    }
    if (persisted.status !== "ACTIVE") {
      throw new Error("Battle player-state write-back requires an active owned Pokemon");
    }

    const pokemonUpdated = await client.query(
      `UPDATE pokemon_instances
       SET current_hp = $3,
           revision = revision + 1,
           updated_at = now()
       WHERE id = $1
         AND owner_player_id = $2
         AND status = 'ACTIVE'`,
      [combatant.pokemonInstanceId, persisted.owner_player_id, combatant.currentHp],
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
