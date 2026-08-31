import type { PoolClient } from "pg";
import type { BattlePokemonBuild } from "../../modules/battle/ports.js";

interface PokemonRow {
  readonly pokemon_instance_id: string;
  readonly roster_position: number;
  readonly form_id: string;
  readonly species_id: string;
  readonly level: number;
  readonly current_hp: number;
  readonly type1_id: string;
  readonly type1_slug: string;
  readonly type2_id: string | null;
  readonly type2_slug: string | null;
  readonly base_hp: number;
  readonly base_attack: number;
  readonly base_defense: number;
  readonly base_sp_attack: number;
  readonly base_sp_defense: number;
  readonly base_speed: number;
  readonly iv_hp: number | null;
  readonly iv_attack: number | null;
  readonly iv_defense: number | null;
  readonly iv_sp_attack: number | null;
  readonly iv_sp_defense: number | null;
  readonly iv_speed: number | null;
  readonly nature_id: string | null;
  readonly increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  readonly decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  readonly ability_id: string | null;
  readonly ability_effect_key: string | null;
  readonly ability_effect_config: unknown;
}

interface MoveRow {
  readonly slot_no: number;
  readonly move_id: string;
  readonly type_id: string;
  readonly type_slug: string;
  readonly category: "PHYSICAL" | "SPECIAL" | "STATUS";
  readonly power: number | null;
  readonly accuracy: number | null;
  readonly priority: number;
  readonly max_pp: number | null;
  readonly pp_current: number | null;
  readonly effect_key: string | null;
  readonly effect_config: unknown;
  readonly flags: unknown;
}

function maxHp(baseHp: number, ivHp: number, level: number): number {
  return Math.floor(((2 * baseHp + ivHp) * level) / 100) + level + 10;
}

function moveContact(flags: unknown): boolean {
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) return false;
  const value = flags as Record<string, unknown>;
  return value.schemaVersion === 1 && value.makesContact === true;
}

function majorStatus(value: string | undefined): BattlePokemonBuild["majorStatus"] {
  if (
    value === "BURN" ||
    value === "POISON" ||
    value === "PARALYSIS" ||
    value === "SLEEP" ||
    value === "FREEZE"
  ) {
    return value;
  }
  return null;
}

async function movesForPokemon(
  client: PoolClient,
  releaseId: string,
  pokemonInstanceId: string,
): Promise<readonly MoveRow[]> {
  const result = await client.query<MoveRow>(
    `SELECT pms.slot_no, pms.move_id, mr.type_id, pt.slug AS type_slug,
            mr.category, mr.power, mr.accuracy, mr.priority, mr.max_pp,
            pms.pp_current, mr.effect_key, mr.effect_config, mr.flags
     FROM pokemon_move_slots pms
     JOIN move_revisions mr
       ON mr.move_id = pms.move_id AND mr.content_release_id = $1
     JOIN pokemon_types pt ON pt.id = mr.type_id
     WHERE pms.pokemon_instance_id = $2
     ORDER BY pms.slot_no`,
    [releaseId, pokemonInstanceId],
  );
  return result.rows;
}

async function enrichPlayerPokemon(
  client: PoolClient,
  releaseId: string,
  row: PokemonRow,
): Promise<BattlePokemonBuild> {
  if (row.nature_id === null || row.ability_id === null) {
    throw new Error("Battle player Pokemon is missing Nature or Ability");
  }
  const moves = await movesForPokemon(client, releaseId, row.pokemon_instance_id);
  if (moves.length === 0 || moves.length > 4) {
    throw new Error("Battle player Pokemon must have 1..4 move slots");
  }
  const conditions = await client.query<{ condition_key: string }>(
    `SELECT condition_key
     FROM pokemon_persistent_conditions
     WHERE pokemon_instance_id = $1
       AND condition_key IN ('BURN','POISON','PARALYSIS','SLEEP','FREEZE')
     ORDER BY condition_key`,
    [row.pokemon_instance_id],
  );
  if (conditions.rowCount !== null && conditions.rowCount > 1) {
    throw new Error("Pokemon has more than one persistent major battle condition");
  }
  const ivs = {
    hp: row.iv_hp ?? 0,
    attack: row.iv_attack ?? 0,
    defense: row.iv_defense ?? 0,
    spAttack: row.iv_sp_attack ?? 0,
    spDefense: row.iv_sp_defense ?? 0,
    speed: row.iv_speed ?? 0,
  };
  const hp = maxHp(row.base_hp, ivs.hp, row.level);
  return {
    pokemonInstanceId: row.pokemon_instance_id,
    participantKind: "PLAYER_POKEMON",
    rosterPosition: row.roster_position,
    formId: row.form_id,
    speciesId: row.species_id,
    level: row.level,
    type1Id: row.type1_id,
    type1Slug: row.type1_slug,
    type2Id: row.type2_id,
    type2Slug: row.type2_slug,
    baseStats: {
      hp: row.base_hp,
      attack: row.base_attack,
      defense: row.base_defense,
      spAttack: row.base_sp_attack,
      spDefense: row.base_sp_defense,
      speed: row.base_speed,
    },
    ivs,
    nature: {
      natureId: row.nature_id,
      increasedStat: row.increased_stat,
      decreasedStat: row.decreased_stat,
    },
    ability: {
      abilityId: row.ability_id,
      effectKey: row.ability_effect_key,
      effectConfig: row.ability_effect_config,
    },
    moves: moves.map((move) => ({
      slotNo: move.slot_no,
      moveId: move.move_id,
      typeId: move.type_id,
      typeSlug: move.type_slug,
      category: move.category,
      power: move.power,
      accuracy: move.accuracy,
      priority: move.priority,
      maxPp: move.max_pp,
      ppCurrent: move.pp_current,
      effectKey: move.effect_key,
      effectConfig: move.effect_config,
      makesContact: moveContact(move.flags),
    })),
    maxHp: hp,
    currentHp: Math.min(row.current_hp, hp),
    majorStatus: majorStatus(conditions.rows[0]?.condition_key),
  };
}

export async function loadPlayerBattleParty(
  client: PoolClient,
  contentReleaseId: string,
  playerId: string,
): Promise<readonly BattlePokemonBuild[]> {
  const party = await client.query<PokemonRow>(
    `SELECT pi.id AS pokemon_instance_id, prs.slot_no AS roster_position,
            pi.form_id, pf.species_id, pi.level, pi.current_hp,
            pfr.type1_id, t1.slug AS type1_slug, pfr.type2_id, t2.slug AS type2_slug,
            pfr.base_hp, pfr.base_attack, pfr.base_defense, pfr.base_sp_attack,
            pfr.base_sp_defense, pfr.base_speed,
            ptv.iv_hp, ptv.iv_attack, ptv.iv_defense, ptv.iv_sp_attack,
            ptv.iv_sp_defense, ptv.iv_speed, ptv.nature_id,
            nr.increased_stat, nr.decreased_stat,
            pi.ability_id, ar.effect_key AS ability_effect_key,
            ar.effect_config AS ability_effect_config
     FROM pokemon_roster_slots prs
     JOIN pokemon_instances pi
       ON pi.id = prs.pokemon_instance_id AND pi.owner_player_id = prs.player_id
     JOIN pokemon_forms pf ON pf.id = pi.form_id
     JOIN pokemon_form_revisions pfr
       ON pfr.form_id = pi.form_id AND pfr.content_release_id = $2
     JOIN pokemon_types t1 ON t1.id = pfr.type1_id
     LEFT JOIN pokemon_types t2 ON t2.id = pfr.type2_id
     LEFT JOIN pokemon_training_values ptv ON ptv.pokemon_instance_id = pi.id
     LEFT JOIN nature_revisions nr
       ON nr.nature_id = ptv.nature_id AND nr.content_release_id = $2
     LEFT JOIN ability_revisions ar
       ON ar.ability_id = pi.ability_id AND ar.content_release_id = $2
     WHERE prs.player_id = $1
       AND prs.placement_kind = 'TEAM'
       AND pi.status = 'ACTIVE'
     ORDER BY prs.slot_no`,
    [playerId, contentReleaseId],
  );

  const output: BattlePokemonBuild[] = [];
  for (const row of party.rows) {
    output.push(await enrichPlayerPokemon(client, contentReleaseId, row));
  }
  return output;
}
