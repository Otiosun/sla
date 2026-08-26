import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import {
  BattleStateSchema,
  EMPTY_BATTLE_STAGES,
  type BattleCombatant,
  type BattleMoveSnapshot,
  type BattleState,
} from "../../src/modules/battle/contracts.js";
import { RulesetConfigSchema } from "../../src/modules/catalog/contracts.js";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import {
  pokemonXpRequiredForNextLevel,
  trainerPointsRequiredForLevel,
} from "../../src/modules/progression/rules.js";
import { calculatePokemonStats } from "../../src/modules/pokemon/stats.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 11 progression proof");
}

const IVS = { hp: 12, attack: 13, defense: 14, spAttack: 15, spDefense: 16, speed: 17 } as const;

interface ReleaseRef {
  readonly releaseId: string;
  readonly rulesetId: string;
}

interface FormView {
  readonly formId: string;
  readonly speciesId: string;
  readonly type1Id: string;
  readonly type1Slug: string;
  readonly type2Id: string | null;
  readonly type2Slug: string | null;
  readonly baseStats: {
    readonly hp: number;
    readonly attack: number;
    readonly defense: number;
    readonly spAttack: number;
    readonly spDefense: number;
    readonly speed: number;
  };
}

interface NatureView {
  readonly natureId: string;
  readonly increasedStat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  readonly decreasedStat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
}

interface AbilityView {
  readonly abilityId: string;
  readonly effectKey: string | null;
  readonly effectConfig: unknown;
}

interface PlayerPokemonFixture {
  readonly playerId: string;
  readonly pokemonId: string;
}

interface TerminalBattleFixture {
  readonly battleId: string;
  readonly terminalPlayerHp: number;
  readonly terminalFirstMovePp: number | null;
}

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

function expectFailure(
  label: string,
  result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly code: string } },
  code: string,
): void {
  if (result.ok || result.error.code !== code) {
    throw new Error(`${label} expected ${code}, got ${result.ok ? "OK" : result.error.code}`);
  }
}

async function activeRelease(pool: Pool): Promise<ReleaseRef> {
  const result = await pool.query<{ release_id: string; ruleset_id: string }>(
    `SELECT release.id AS release_id, release.default_ruleset_id AS ruleset_id
     FROM content_release_pointers pointer
     JOIN content_releases release ON release.id = pointer.content_release_id
     WHERE pointer.pointer_key = 'ACTIVE' AND release.status = 'PUBLISHED'`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Active content release is missing");
  return { releaseId: row.release_id, rulesetId: row.ruleset_id };
}

async function releaseByNumber(pool: Pool, releaseNo: number): Promise<ReleaseRef> {
  const result = await pool.query<{ release_id: string; ruleset_id: string }>(
    `SELECT id AS release_id, default_ruleset_id AS ruleset_id
     FROM content_releases WHERE release_no = $1`,
    [releaseNo],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Content release ${releaseNo} is missing`);
  return { releaseId: row.release_id, rulesetId: row.ruleset_id };
}

async function rulesConfig(pool: Pool, rulesetId: string) {
  const result = await pool.query<{ config: unknown }>("SELECT config FROM rulesets WHERE id = $1", [
    rulesetId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error("Ruleset is missing");
  return RulesetConfigSchema.parse(row.config);
}

async function loadForm(pool: Pool, releaseId: string, speciesSlug: string): Promise<FormView> {
  const result = await pool.query<{
    form_id: string;
    species_id: string;
    type1_id: string;
    type1_slug: string;
    type2_id: string | null;
    type2_slug: string | null;
    base_hp: number;
    base_attack: number;
    base_defense: number;
    base_sp_attack: number;
    base_sp_defense: number;
    base_speed: number;
  }>(
    `SELECT form.id AS form_id, species.id AS species_id,
            revision.type1_id, type1.slug AS type1_slug,
            revision.type2_id, type2.slug AS type2_slug,
            revision.base_hp, revision.base_attack, revision.base_defense,
            revision.base_sp_attack, revision.base_sp_defense, revision.base_speed
     FROM pokemon_species species
     JOIN pokemon_forms form ON form.species_id = species.id AND form.slug = 'default'
     JOIN pokemon_form_revisions revision
       ON revision.form_id = form.id AND revision.content_release_id = $1 AND revision.active = TRUE
     JOIN pokemon_types type1 ON type1.id = revision.type1_id
     LEFT JOIN pokemon_types type2 ON type2.id = revision.type2_id
     WHERE species.slug = $2`,
    [releaseId, speciesSlug],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Form ${speciesSlug} is missing from release`);
  return {
    formId: row.form_id,
    speciesId: row.species_id,
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
  };
}

async function loadNature(pool: Pool, releaseId: string): Promise<NatureView> {
  const result = await pool.query<{
    nature_id: string;
    increased_stat: NatureView["increasedStat"];
    decreased_stat: NatureView["decreasedStat"];
  }>(
    `SELECT nature.id AS nature_id, revision.increased_stat, revision.decreased_stat
     FROM natures nature
     JOIN nature_revisions revision
       ON revision.nature_id = nature.id AND revision.content_release_id = $1 AND revision.active = TRUE
     WHERE nature.slug = 'hardy'`,
    [releaseId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Hardy Nature is missing from release");
  return {
    natureId: row.nature_id,
    increasedStat: row.increased_stat,
    decreasedStat: row.decreased_stat,
  };
}

async function loadAbility(pool: Pool, releaseId: string, formId: string): Promise<AbilityView> {
  const result = await pool.query<{
    ability_id: string;
    effect_key: string | null;
    effect_config: unknown;
  }>(
    `SELECT option.ability_id, revision.effect_key, revision.effect_config
     FROM pokemon_form_ability_options option
     JOIN ability_revisions revision
       ON revision.ability_id = option.ability_id
      AND revision.content_release_id = option.content_release_id
     WHERE option.content_release_id = $1 AND option.form_id = $2 AND option.active = TRUE
     ORDER BY CASE option.slot_kind WHEN 'PRIMARY' THEN 1 WHEN 'SECONDARY' THEN 2 ELSE 3 END,
              option.ability_id
     LIMIT 1`,
    [releaseId, formId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Form has no active Ability option");
  return { abilityId: row.ability_id, effectKey: row.effect_key, effectConfig: row.effect_config };
}

async function loadMove(
  pool: Pool,
  releaseId: string,
  slug: string,
  slotNo: number,
  ppOverride?: number | null,
): Promise<BattleMoveSnapshot> {
  const result = await pool.query<{
    move_id: string;
    type_id: string;
    type_slug: string;
    category: "PHYSICAL" | "SPECIAL" | "STATUS";
    power: number | null;
    accuracy: number | null;
    priority: number;
    max_pp: number | null;
    effect_key: string | null;
    effect_config: unknown;
  }>(
    `SELECT move.id AS move_id, revision.type_id, type.slug AS type_slug,
            revision.category, revision.power, revision.accuracy, revision.priority,
            revision.max_pp, revision.effect_key, revision.effect_config
     FROM moves move
     JOIN move_revisions revision
       ON revision.move_id = move.id AND revision.content_release_id = $1 AND revision.active = TRUE
     JOIN pokemon_types type ON type.id = revision.type_id
     WHERE move.slug = $2`,
    [releaseId, slug],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Move ${slug} is missing from release`);
  return {
    slotNo,
    moveId: row.move_id,
    typeId: row.type_id,
    typeSlug: row.type_slug,
    category: row.category,
    power: row.power,
    accuracy: row.accuracy,
    priority: row.priority,
    maxPp: row.max_pp,
    ppCurrent: ppOverride === undefined ? row.max_pp : ppOverride,
    effectKey: row.effect_key,
    effectConfig: row.effect_config,
    flags: { makesContact: false },
  };
}

async function createPlayerPokemon(
  pool: Pool,
  release: ReleaseRef,
  input: {
    readonly speciesSlug: string;
    readonly level: number;
    readonly xp: number;
    readonly moveSlugs: readonly string[];
    readonly trainerLevel: number;
    readonly trainerPoints: number;
  },
): Promise<PlayerPokemonFixture> {
  const playerId = randomUUID();
  const pokemonId = randomUUID();
  const form = await loadForm(pool, release.releaseId, input.speciesSlug);
  const nature = await loadNature(pool, release.releaseId);
  const ability = await loadAbility(pool, release.releaseId, form.formId);
  const config = await rulesConfig(pool, release.rulesetId);
  const stats = calculatePokemonStats({
    baseStats: form.baseStats,
    ivs: IVS,
    level: input.level,
    nature,
    ivEnabled: config.battle.ivEnabled,
    natureEnabled: config.battle.natureEnabled,
  });

  await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  await pool.query(
    `INSERT INTO trainer_progression(player_id, level, progression_points)
     VALUES ($1, $2, $3)`,
    [playerId, input.trainerLevel, input.trainerPoints],
  );
  await pool.query(
    `INSERT INTO pokemon_instances(
       id, owner_player_id, form_id, level, xp, current_hp, ability_id,
       origin_type, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PHASE11_PROOF', '{}'::jsonb)`,
    [pokemonId, playerId, form.formId, input.level, input.xp, stats.hp, ability.abilityId],
  );
  await pool.query(
    `INSERT INTO pokemon_training_values(
       pokemon_instance_id, nature_id, iv_hp, iv_attack, iv_defense,
       iv_sp_attack, iv_sp_defense, iv_speed
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      pokemonId,
      nature.natureId,
      IVS.hp,
      IVS.attack,
      IVS.defense,
      IVS.spAttack,
      IVS.spDefense,
      IVS.speed,
    ],
  );
  for (const [index, slug] of input.moveSlugs.entries()) {
    const move = await loadMove(pool, release.releaseId, slug, index + 1);
    await pool.query(
      `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
       VALUES ($1, $2, $3, $4)`,
      [pokemonId, move.slotNo, move.moveId, move.ppCurrent],
    );
  }
  await pool.query(
    `INSERT INTO pokemon_roster_slots(
       pokemon_instance_id, player_id, placement_kind, box_no, slot_no
     ) VALUES ($1, $2, 'TEAM', NULL, 1)`,
    [pokemonId, playerId],
  );
  await pool.query(
    `INSERT INTO player_pokedex_species(
       player_id, species_id, seen_count, caught_count,
       first_seen_at, last_seen_at, first_caught_at, last_caught_at
     ) VALUES ($1, $2, 1, 1, now(), now(), now(), now())`,
    [playerId, form.speciesId],
  );
  return { playerId, pokemonId };
}

async function setPokemonProgress(
  pool: Pool,
  release: ReleaseRef,
  pokemonId: string,
  level: number,
  xp: number,
): Promise<void> {
  await pool.query("UPDATE pokemon_instances SET level = $2, xp = $3 WHERE id = $1", [
    pokemonId,
    level,
    xp,
  ]);
  const combatant = await loadOwnedCombatant(pool, release, pokemonId, 0, null, false);
  await pool.query("UPDATE pokemon_instances SET current_hp = $2 WHERE id = $1", [
    pokemonId,
    combatant.maxHp,
  ]);
}

async function setTrainerProgress(
  pool: Pool,
  playerId: string,
  level: number,
  points: number,
): Promise<void> {
  await pool.query(
    `UPDATE trainer_progression
     SET level = $2, progression_points = $3, revision = revision + 1, updated_at = now()
     WHERE player_id = $1`,
    [playerId, level, points],
  );
}

async function loadOwnedCombatant(
  pool: Pool,
  release: ReleaseRef,
  pokemonId: string,
  damage: number,
  majorStatus: "POISON" | null,
  reduceFirstPp: boolean,
): Promise<BattleCombatant> {
  const root = await pool.query<{
    player_id: string;
    form_id: string;
    species_id: string;
    level: number;
    type1_id: string;
    type1_slug: string;
    type2_id: string | null;
    type2_slug: string | null;
    base_hp: number;
    base_attack: number;
    base_defense: number;
    base_sp_attack: number;
    base_sp_defense: number;
    base_speed: number;
    nature_id: string;
    increased_stat: NatureView["increasedStat"];
    decreased_stat: NatureView["decreasedStat"];
    ability_id: string;
    effect_key: string | null;
    effect_config: unknown;
    iv_hp: number;
    iv_attack: number;
    iv_defense: number;
    iv_sp_attack: number;
    iv_sp_defense: number;
    iv_speed: number;
  }>(
    `SELECT instance.owner_player_id AS player_id, instance.form_id, form.species_id, instance.level,
            revision.type1_id, type1.slug AS type1_slug,
            revision.type2_id, type2.slug AS type2_slug,
            revision.base_hp, revision.base_attack, revision.base_defense,
            revision.base_sp_attack, revision.base_sp_defense, revision.base_speed,
            training.nature_id, nature.increased_stat, nature.decreased_stat,
            instance.ability_id, ability.effect_key, ability.effect_config,
            training.iv_hp, training.iv_attack, training.iv_defense,
            training.iv_sp_attack, training.iv_sp_defense, training.iv_speed
     FROM pokemon_instances instance
     JOIN pokemon_training_values training ON training.pokemon_instance_id = instance.id
     JOIN pokemon_forms form ON form.id = instance.form_id
     JOIN pokemon_form_revisions revision
       ON revision.form_id = instance.form_id AND revision.content_release_id = $2
     JOIN pokemon_types type1 ON type1.id = revision.type1_id
     LEFT JOIN pokemon_types type2 ON type2.id = revision.type2_id
     JOIN nature_revisions nature
       ON nature.nature_id = training.nature_id AND nature.content_release_id = $2
     JOIN ability_revisions ability
       ON ability.ability_id = instance.ability_id AND ability.content_release_id = $2
     WHERE instance.id = $1`,
    [pokemonId, release.releaseId],
  );
  const row = root.rows[0];
  if (row === undefined) throw new Error("Owned Pokemon combatant fixture is incomplete");
  const config = await rulesConfig(pool, release.rulesetId);
  const nature: NatureView = {
    natureId: row.nature_id,
    increasedStat: row.increased_stat,
    decreasedStat: row.decreased_stat,
  };
  const baseStats = {
    hp: row.base_hp,
    attack: row.base_attack,
    defense: row.base_defense,
    spAttack: row.base_sp_attack,
    spDefense: row.base_sp_defense,
    speed: row.base_speed,
  };
  const ivs = {
    hp: row.iv_hp,
    attack: row.iv_attack,
    defense: row.iv_defense,
    spAttack: row.iv_sp_attack,
    spDefense: row.iv_sp_defense,
    speed: row.iv_speed,
  };
  const stats = calculatePokemonStats({
    baseStats,
    ivs,
    level: row.level,
    nature,
    ivEnabled: config.battle.ivEnabled,
    natureEnabled: config.battle.natureEnabled,
  });
  const moveRows = await pool.query<{
    slot_no: number;
    slug: string;
    pp_current: number | null;
  }>(
    `SELECT slot.slot_no, move.slug, slot.pp_current
     FROM pokemon_move_slots slot
     JOIN moves move ON move.id = slot.move_id
     WHERE slot.pokemon_instance_id = $1
     ORDER BY slot.slot_no`,
    [pokemonId],
  );
  const moves: BattleMoveSnapshot[] = [];
  for (const moveRow of moveRows.rows) {
    const pp =
      reduceFirstPp && moveRow.slot_no === 1 && moveRow.pp_current !== null
        ? Math.max(0, moveRow.pp_current - 1)
        : moveRow.pp_current;
    moves.push(await loadMove(pool, release.releaseId, moveRow.slug, moveRow.slot_no, pp));
  }
  if (moves.length === 0) throw new Error("Owned Pokemon fixture has no moves");
  return {
    participantId: randomUUID(),
    sideNo: 1,
    rosterPosition: 1,
    participantKind: "PLAYER_POKEMON",
    pokemonInstanceId: pokemonId,
    formId: row.form_id,
    speciesId: row.species_id,
    level: row.level,
    type1Id: row.type1_id,
    type1Slug: row.type1_slug,
    type2Id: row.type2_id,
    type2Slug: row.type2_slug,
    baseStats,
    ivs,
    nature,
    ability: {
      abilityId: row.ability_id,
      effectKey: row.effect_key,
      effectConfig: row.effect_config,
    },
    moves,
    maxHp: stats.hp,
    currentHp: Math.max(1, stats.hp - damage),
    majorStatus: majorStatus === null ? null : { key: majorStatus, counter: null },
    stages: { ...EMPTY_BATTLE_STAGES },
    volatile: { flinch: false, confusionTurns: 0 },
  };
}

async function loadWildCombatant(
  pool: Pool,
  release: ReleaseRef,
  participantId: string,
): Promise<BattleCombatant> {
  const form = await loadForm(pool, release.releaseId, "pidgey");
  const nature = await loadNature(pool, release.releaseId);
  const ability = await loadAbility(pool, release.releaseId, form.formId);
  const config = await rulesConfig(pool, release.rulesetId);
  const ivs = { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
  const stats = calculatePokemonStats({
    baseStats: form.baseStats,
    ivs,
    level: 100,
    nature,
    ivEnabled: config.battle.ivEnabled,
    natureEnabled: config.battle.natureEnabled,
  });
  const move = await loadMove(pool, release.releaseId, "tackle", 1);
  return {
    participantId,
    sideNo: 2,
    rosterPosition: 1,
    participantKind: "WILD_POKEMON",
    pokemonInstanceId: null,
    formId: form.formId,
    speciesId: form.speciesId,
    level: 100,
    type1Id: form.type1Id,
    type1Slug: form.type1Slug,
    type2Id: form.type2Id,
    type2Slug: form.type2Slug,
    baseStats: form.baseStats,
    ivs,
    nature,
    ability,
    moves: [move],
    maxHp: stats.hp,
    currentHp: 0,
    majorStatus: null,
    stages: { ...EMPTY_BATTLE_STAGES },
    volatile: { flinch: false, confusionTurns: 0 },
  };
}

async function createTerminalBattle(
  pool: Pool,
  release: ReleaseRef,
  fixture: PlayerPokemonFixture,
  status: "WON" | "LOST",
): Promise<TerminalBattleFixture> {
  const battleId = randomUUID();
  const player = await loadOwnedCombatant(
    pool,
    release,
    fixture.pokemonId,
    status === "WON" ? 3 : 0,
    status === "WON" ? "POISON" : null,
    status === "WON",
  );
  const playerParticipantId = player.participantId;
  const wildParticipantId = randomUUID();
  const wild = await loadWildCombatant(pool, release, wildParticipantId);
  const normalizedPlayer: BattleCombatant =
    status === "WON" ? player : { ...player, currentHp: 0, majorStatus: null };
  const normalizedWild: BattleCombatant =
    status === "WON" ? wild : { ...wild, currentHp: wild.maxHp };
  const state: BattleState = BattleStateSchema.parse({
    schemaVersion: 1,
    battleId,
    battleType: "WILD",
    status,
    contentReleaseId: release.releaseId,
    rulesetId: release.rulesetId,
    encounterId: null,
    turnNumber: 1,
    version: 1,
    rngCounter: "0",
    sides: [
      {
        sideNo: 1,
        controllerKind: "PLAYER",
        playerId: fixture.playerId,
        participantIds: [playerParticipantId],
        activeParticipantId: playerParticipantId,
        result: status === "WON" ? "WON" : "LOST",
      },
      {
        sideNo: 2,
        controllerKind: "WILD",
        playerId: null,
        participantIds: [wildParticipantId],
        activeParticipantId: wildParticipantId,
        result: status === "WON" ? "LOST" : "WON",
      },
    ],
    combatants: [normalizedPlayer, normalizedWild],
  });

  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id, encounter_id,
       turn_number, version, rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag,
       rng_seed_key_version, rng_counter, ended_at
     ) VALUES ($1, 'WILD', $2, $3, $4, NULL, 1, 1, $5, $6, $7, 1, 0, now())`,
    [
      battleId,
      status,
      release.releaseId,
      release.rulesetId,
      Buffer.alloc(32, 0x11),
      Buffer.alloc(12, 0x22),
      Buffer.alloc(16, 0x33),
    ],
  );
  const playerSideId = randomUUID();
  const wildSideId = randomUUID();
  await pool.query(
    `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id, result)
     VALUES ($1, $2, 1, 'PLAYER', $3, $4),
            ($5, $2, 2, 'WILD', NULL, $6)`,
    [
      playerSideId,
      battleId,
      fixture.playerId,
      status === "WON" ? "WON" : "LOST",
      wildSideId,
      status === "WON" ? "LOST" : "WON",
    ],
  );
  await pool.query(
    `INSERT INTO battle_participants(
       id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
       roster_position, active_member, snapshot
     ) VALUES ($1, $2, $3, $4, 'PLAYER_POKEMON', 1, TRUE, $5::jsonb),
              ($6, $2, $7, NULL, 'WILD_POKEMON', 1, TRUE, $8::jsonb)`,
    [
      playerParticipantId,
      battleId,
      playerSideId,
      fixture.pokemonId,
      JSON.stringify(normalizedPlayer),
      wildParticipantId,
      wildSideId,
      JSON.stringify(normalizedWild),
    ],
  );
  await pool.query(
    `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
     VALUES ($1, 1, 1, $2::jsonb)`,
    [battleId, JSON.stringify(state)],
  );
  return {
    battleId,
    terminalPlayerHp: normalizedPlayer.currentHp,
    terminalFirstMovePp: normalizedPlayer.moves[0]?.ppCurrent ?? null,
  };
}

async function auditState(pool: Pool, fixture: PlayerPokemonFixture): Promise<unknown> {
  const pokemon = await pool.query<{
    form_id: string;
    level: number;
    xp: string;
    current_hp: number;
    ability_id: string | null;
    revision: string;
  }>(
    `SELECT form_id, level, xp::text, current_hp, ability_id, revision::text
     FROM pokemon_instances WHERE id = $1`,
    [fixture.pokemonId],
  );
  const moves = await pool.query<{ slot_no: number; move_id: string; pp_current: number | null }>(
    `SELECT slot_no, move_id, pp_current FROM pokemon_move_slots
     WHERE pokemon_instance_id = $1 ORDER BY slot_no`,
    [fixture.pokemonId],
  );
  const conditions = await pool.query<{ condition_key: string }>(
    `SELECT condition_key FROM pokemon_persistent_conditions
     WHERE pokemon_instance_id = $1 ORDER BY condition_key`,
    [fixture.pokemonId],
  );
  const trainer = await pool.query<{ level: number; points: string; revision: string }>(
    `SELECT level, progression_points::text AS points, revision::text
     FROM trainer_progression WHERE player_id = $1`,
    [fixture.playerId],
  );
  const unlocks = await pool.query<{ unlock_key: string; status: string }>(
    `SELECT unlock_key, status FROM trainer_unlocks
     WHERE player_id = $1 ORDER BY unlock_key`,
    [fixture.playerId],
  );
  const counts = await pool.query<{
    xp_ledgers: string;
    trainer_ledgers: string;
    reward_claims: string;
    evolution_claims: string;
    pending_choices: string;
    histories: string;
    outbox: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM pokemon_xp_ledger WHERE pokemon_instance_id = $1) AS xp_ledgers,
       (SELECT count(*)::text FROM trainer_progress_ledger WHERE player_id = $2) AS trainer_ledgers,
       (SELECT count(*)::text FROM battle_reward_claims WHERE player_id = $2) AS reward_claims,
       (SELECT count(*)::text FROM pokemon_evolution_claims WHERE pokemon_instance_id = $1) AS evolution_claims,
       (SELECT count(*)::text FROM pending_move_choices WHERE pokemon_instance_id = $1) AS pending_choices,
       (SELECT count(*)::text FROM pokemon_history_events WHERE pokemon_instance_id = $1) AS histories,
       (SELECT count(*)::text FROM outbox_messages WHERE destination_ref = $2) AS outbox`,
    [fixture.pokemonId, fixture.playerId],
  );
  return {
    pokemon: pokemon.rows[0] ?? null,
    moves: moves.rows,
    conditions: conditions.rows,
    trainer: trainer.rows[0] ?? null,
    unlocks: unlocks.rows,
    counts: counts.rows[0] ?? null,
  };
}

async function assertBattleClaimCounts(pool: Pool, battleId: string, expected: number): Promise<void> {
  const result = await pool.query<{
    reward_claims: string;
    xp_ledgers: string;
    trainer_ledgers: string;
    outbox: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM battle_reward_claims WHERE battle_id = $1) AS reward_claims,
       (SELECT count(*)::text FROM pokemon_xp_ledger WHERE source_type = 'BATTLE_REWARD' AND source_id = $1) AS xp_ledgers,
       (SELECT count(*)::text FROM trainer_progress_ledger WHERE source_type = 'BATTLE_REWARD' AND source_id = $1) AS trainer_ledgers,
       (SELECT count(*)::text FROM outbox_messages WHERE idempotency_key = 'progression.reward:' || $1) AS outbox`,
    [battleId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    Number(row.reward_claims) !== expected ||
    Number(row.xp_ledgers) !== expected ||
    Number(row.trainer_ledgers) !== expected ||
    Number(row.outbox) !== expected
  ) {
    throw new Error(`Unexpected exactly-once counts for battle ${battleId}: ${JSON.stringify(row)}`);
  }
}

async function createItemEvolutionRelease(pool: Pool, parent: ReleaseRef): Promise<{ release: ReleaseRef; itemId: string }> {
  const catalog = new CatalogService(new PostgresCatalogRepository(pool));
  const newReleaseId = randomUUID();
  unwrap(
    "clone item-evolution proof release",
    await catalog.clonePublishedRelease({
      parentReleaseId: parent.releaseId,
      newReleaseId,
      releaseNo: 11_001n,
      name: "Phase 11 Item Evolution Proof",
    }),
  );
  const from = await loadForm(pool, newReleaseId, "bulbasaur");
  const to = await loadForm(pool, newReleaseId, "ivysaur");
  const item = await pool.query<{ id: string }>("SELECT id FROM items WHERE slug = 'potion'");
  const itemId = item.rows[0]?.id;
  if (itemId === undefined) throw new Error("Potion item identity is missing");
  await pool.query(
    `INSERT INTO evolution_rules(
       id, content_release_id, from_form_id, to_form_id, trigger_kind, trigger_config, active
     ) VALUES ($1, $2, $3, $4, 'ITEM', $5::jsonb, TRUE)`,
    [randomUUID(), newReleaseId, from.formId, to.formId, JSON.stringify({ itemId })],
  );
  unwrap("validate item-evolution proof release", await catalog.validateRelease(newReleaseId));
  unwrap("publish item-evolution proof release", await catalog.publishRelease(newReleaseId));
  unwrap("activate item-evolution proof release", await catalog.activateRelease(newReleaseId));
  return { release: { releaseId: newReleaseId, rulesetId: parent.rulesetId }, itemId };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 16 });
  try {
    const phase11 = await activeRelease(pool);
    const phase1 = await releaseByNumber(pool, 1);
    const vineWhip = await loadMove(pool, phase11.releaseId, "vine-whip", 3);

    const primary = await createPlayerPokemon(pool, phase11, {
      speciesSlug: "bulbasaur",
      level: 6,
      xp: pokemonXpRequiredForNextLevel(6) - 1,
      moveSlugs: ["tackle", "growl"],
      trainerLevel: 9,
      trainerPoints: trainerPointsRequiredForLevel(10) - 100,
    });
    const crashBattle = await createTerminalBattle(pool, phase11, primary, "WON");
    const crashInput = {
      battleId: crashBattle.battleId,
      idempotencyKey: "phase11-crash-reward",
      correlationId: randomUUID(),
    };
    const beforeCrash = await auditState(pool, primary);
    const faulted = new ProgressionService(
      new PostgresProgressionRepository(pool, {
        afterRewardMutationsBeforeClaim: () => {
          throw new Error("phase11 injected crash before reward claim");
        },
      }),
    );
    let crashObserved = false;
    try {
      await faulted.applyBattleReward(crashInput);
    } catch (error) {
      crashObserved = error instanceof Error && error.message.includes("phase11 injected crash");
    }
    if (!crashObserved) throw new Error("Injected reward crash was not observed");
    const afterCrash = await auditState(pool, primary);
    if (!isDeepStrictEqual(afterCrash, beforeCrash)) {
      throw new Error(
        `Reward crash leaked partial state: before=${JSON.stringify(beforeCrash)} after=${JSON.stringify(afterCrash)}`,
      );
    }

    const service = new ProgressionService(new PostgresProgressionRepository(pool));
    const first = unwrap("apply reward after crash", await service.applyBattleReward(crashInput));
    if (first.replayed) throw new Error("First successful reward unexpectedly replayed");
    const firstPokemon = first.pokemon[0];
    if (firstPokemon === undefined || firstPokemon.afterLevel !== 10) {
      throw new Error(`Expected level 10 after multi-level reward: ${JSON.stringify(firstPokemon)}`);
    }
    if (!firstPokemon.learnedMoveIds.includes(vineWhip.moveId)) {
      throw new Error("Level 7 free-slot move was not learned during multi-level reward");
    }
    if (first.trainer.afterLevel !== 10 || !first.trainer.unlockKeys.includes("tournament.tier-1")) {
      throw new Error(`Trainer tier-1 unlock was not granted: ${JSON.stringify(first.trainer)}`);
    }
    await assertBattleClaimCounts(pool, crashBattle.battleId, 1);
    const persistedAfterFirst = await pool.query<{
      pp_current: number | null;
      current_hp: number;
      poison: string;
      unlock: string;
    }>(
      `SELECT
         (SELECT pp_current FROM pokemon_move_slots WHERE pokemon_instance_id = $1 AND slot_no = 1) AS pp_current,
         (SELECT current_hp FROM pokemon_instances WHERE id = $1) AS current_hp,
         (SELECT count(*)::text FROM pokemon_persistent_conditions WHERE pokemon_instance_id = $1 AND condition_key = 'POISON') AS poison,
         (SELECT count(*)::text FROM trainer_unlocks WHERE player_id = $2 AND unlock_key = 'tournament.tier-1' AND status = 'ACTIVE') AS unlock`,
      [primary.pokemonId, primary.playerId],
    );
    const persistedFirstRow = persistedAfterFirst.rows[0];
    if (
      persistedFirstRow === undefined ||
      persistedFirstRow.pp_current !== crashBattle.terminalFirstMovePp ||
      persistedFirstRow.current_hp <= crashBattle.terminalPlayerHp ||
      persistedFirstRow.poison !== "1" ||
      persistedFirstRow.unlock !== "1"
    ) {
      throw new Error(`Terminal HP/PP/status or trainer unlock did not persist: ${JSON.stringify(persistedFirstRow)}`);
    }
    const replay = unwrap("replay first reward", await service.applyBattleReward(crashInput));
    if (!replay.replayed) throw new Error("Reward retry did not replay persisted result");
    await assertBattleClaimCounts(pool, crashBattle.battleId, 1);

    await setPokemonProgress(
      pool,
      phase11,
      primary.pokemonId,
      15,
      pokemonXpRequiredForNextLevel(15) - 1,
    );
    await setTrainerProgress(
      pool,
      primary.playerId,
      14,
      trainerPointsRequiredForLevel(15) - 100,
    );
    const concurrentBattle = await createTerminalBattle(pool, phase11, primary, "WON");
    const concurrentInput = {
      battleId: concurrentBattle.battleId,
      idempotencyKey: "phase11-concurrent-reward",
      correlationId: randomUUID(),
    };
    const concurrent = await Promise.all([
      new ProgressionService(new PostgresProgressionRepository(pool)).applyBattleReward(concurrentInput),
      new ProgressionService(new PostgresProgressionRepository(pool)).applyBattleReward(concurrentInput),
    ]);
    const concurrentValues = concurrent.map((result, index) => unwrap(`concurrent reward ${index + 1}`, result));
    const replayFlags = concurrentValues.map((value) => value.replayed).sort();
    if (JSON.stringify(replayFlags) !== JSON.stringify([false, true])) {
      throw new Error(`Concurrent reward did not converge to apply+replay: ${JSON.stringify(replayFlags)}`);
    }
    await assertBattleClaimCounts(pool, concurrentBattle.battleId, 1);
    const evolved = await pool.query<{ species_slug: string; level: number; unlock: string; claims: string }>(
      `SELECT species.slug AS species_slug, instance.level,
              (SELECT count(*)::text FROM trainer_unlocks WHERE player_id = $2 AND unlock_key = 'tournament.tier-2' AND status = 'ACTIVE') AS unlock,
              (SELECT count(*)::text FROM pokemon_evolution_claims WHERE pokemon_instance_id = $1 AND source_type = 'BATTLE_REWARD' AND source_id = $3) AS claims
       FROM pokemon_instances instance
       JOIN pokemon_forms form ON form.id = instance.form_id
       JOIN pokemon_species species ON species.id = form.species_id
       WHERE instance.id = $1`,
      [primary.pokemonId, primary.playerId, concurrentBattle.battleId],
    );
    const evolvedRow = evolved.rows[0];
    if (
      evolvedRow === undefined ||
      evolvedRow.species_slug !== "ivysaur" ||
      evolvedRow.level !== 16 ||
      evolvedRow.unlock !== "1" ||
      evolvedRow.claims !== "1"
    ) {
      throw new Error(`Concurrent level evolution/trainer unlock audit failed: ${JSON.stringify(evolvedRow)}`);
    }
    const ivysaurPokedex = await pool.query<{ caught: string }>(
      `SELECT caught_count::text AS caught FROM player_pokedex_species entry
       JOIN pokemon_species species ON species.id = entry.species_id
       WHERE entry.player_id = $1 AND species.slug = 'ivysaur'`,
      [primary.playerId],
    );
    if (Number(ivysaurPokedex.rows[0]?.caught ?? "0") < 1) {
      throw new Error("Evolution did not establish Ivysaur Pokédex ownership invariant");
    }

    const pending = await createPlayerPokemon(pool, phase11, {
      speciesSlug: "bulbasaur",
      level: 6,
      xp: pokemonXpRequiredForNextLevel(6) - 1,
      moveSlugs: ["tackle", "growl", "quick-attack", "thunder-shock"],
      trainerLevel: 1,
      trainerPoints: 0,
    });
    const pendingBattle = await createTerminalBattle(pool, phase11, pending, "WON");
    const pendingReward = unwrap(
      "apply full-moves reward",
      await service.applyBattleReward({
        battleId: pendingBattle.battleId,
        idempotencyKey: "phase11-pending-move",
        correlationId: randomUUID(),
      }),
    );
    const pendingPokemon = pendingReward.pokemon[0];
    const choiceId = pendingPokemon?.pendingMoveChoiceIds[0];
    if (choiceId === undefined || pendingPokemon.learnedMoveIds.length !== 0) {
      throw new Error(`Four-slot level-up did not create a pending move choice: ${JSON.stringify(pendingPokemon)}`);
    }
    const choiceCorrelation = randomUUID();
    const resolvedChoice = unwrap(
      "resolve pending move choice",
      await service.resolveMoveChoice({
        choiceId,
        playerId: pending.playerId,
        replaceSlotNo: 4,
        correlationId: choiceCorrelation,
      }),
    );
    if (resolvedChoice.replayed || resolvedChoice.status !== "RESOLVED" || resolvedChoice.replacedSlotNo !== 4) {
      throw new Error(`Move choice did not resolve exactly once: ${JSON.stringify(resolvedChoice)}`);
    }
    const choiceReplay = unwrap(
      "replay pending move choice",
      await service.resolveMoveChoice({
        choiceId,
        playerId: pending.playerId,
        replaceSlotNo: 4,
        correlationId: choiceCorrelation,
      }),
    );
    if (!choiceReplay.replayed) throw new Error("Move-choice retry did not replay");
    const conflictingChoice = await service.resolveMoveChoice({
      choiceId,
      playerId: pending.playerId,
      replaceSlotNo: 3,
      correlationId: randomUUID(),
    });
    expectFailure("conflicting move choice", conflictingChoice, "MOVE_CHOICE_CONFLICT");
    const slotFour = await pool.query<{ move_id: string; status: string; count: string }>(
      `SELECT slot.move_id, choice.status,
              (SELECT count(*)::text FROM outbox_messages WHERE idempotency_key = 'progression.move-choice:' || $2) AS count
       FROM pokemon_move_slots slot
       JOIN pending_move_choices choice ON choice.id = $2
       WHERE slot.pokemon_instance_id = $1 AND slot.slot_no = 4`,
      [pending.pokemonId, choiceId],
    );
    const slotFourRow = slotFour.rows[0];
    if (slotFourRow === undefined || slotFourRow.move_id !== vineWhip.moveId || slotFourRow.status !== "RESOLVED" || slotFourRow.count !== "1") {
      throw new Error(`Move-choice persistence audit failed: ${JSON.stringify(slotFourRow)}`);
    }

    const lostBefore = await auditState(pool, pending);
    const lostBattle = await createTerminalBattle(pool, phase11, pending, "LOST");
    const lostResult = await service.applyBattleReward({
      battleId: lostBattle.battleId,
      idempotencyKey: "phase11-lost-no-reward",
      correlationId: randomUUID(),
    });
    expectFailure("lost battle reward", lostResult, "BATTLE_REWARD_NOT_ELIGIBLE");
    const lostAfter = await auditState(pool, pending);
    if (!isDeepStrictEqual(lostAfter, lostBefore)) {
      throw new Error("LOST battle mutated progression state");
    }

    const legacyBefore = await auditState(pool, pending);
    const legacyBattle = await createTerminalBattle(pool, phase1, pending, "WON");
    const legacyResult = await service.applyBattleReward({
      battleId: legacyBattle.battleId,
      idempotencyKey: "phase11-legacy-ruleset",
      correlationId: randomUUID(),
    });
    expectFailure("legacy ruleset reward", legacyResult, "PROGRESSION_RULES_MISSING");
    const legacyAfter = await auditState(pool, pending);
    if (!isDeepStrictEqual(legacyAfter, legacyBefore)) {
      throw new Error("Legacy ruleset without progression mutated state");
    }

    const itemProof = await createItemEvolutionRelease(pool, phase11);
    const itemPlayer = await createPlayerPokemon(pool, itemProof.release, {
      speciesSlug: "bulbasaur",
      level: 10,
      xp: 0,
      moveSlugs: ["tackle", "growl", "vine-whip"],
      trainerLevel: 1,
      trainerPoints: 0,
    });
    await pool.query(
      `INSERT INTO inventory_balances(player_id, item_id, quantity)
       VALUES ($1, $2, 1)`,
      [itemPlayer.playerId, itemProof.itemId],
    );
    const itemInput = {
      playerId: itemPlayer.playerId,
      pokemonInstanceId: itemPlayer.pokemonId,
      idempotencyKey: "phase11-item-evolution",
      correlationId: randomUUID(),
      trigger: { kind: "ITEM" as const, itemId: itemProof.itemId },
    };
    const itemEvolution = unwrap("item evolution", await service.evolvePokemon(itemInput));
    if (itemEvolution.replayed || itemEvolution.triggerKind !== "ITEM") {
      throw new Error(`Item evolution did not apply: ${JSON.stringify(itemEvolution)}`);
    }
    const itemReplay = unwrap("item evolution replay", await service.evolvePokemon(itemInput));
    if (!itemReplay.replayed) throw new Error("Item evolution retry did not replay");
    const itemAudit = await pool.query<{
      species_slug: string;
      quantity: string;
      ledgers: string;
      claims: string;
    }>(
      `SELECT species.slug AS species_slug,
              (SELECT quantity::text FROM inventory_balances WHERE player_id = $2 AND item_id = $3) AS quantity,
              (SELECT count(*)::text FROM inventory_ledger WHERE player_id = $2 AND item_id = $3 AND source_type = 'EVOLUTION') AS ledgers,
              (SELECT count(*)::text FROM pokemon_evolution_claims WHERE pokemon_instance_id = $1 AND idempotency_scope = 'progression.evolve') AS claims
       FROM pokemon_instances instance
       JOIN pokemon_forms form ON form.id = instance.form_id
       JOIN pokemon_species species ON species.id = form.species_id
       WHERE instance.id = $1`,
      [itemPlayer.pokemonId, itemPlayer.playerId, itemProof.itemId],
    );
    const itemAuditRow = itemAudit.rows[0];
    if (
      itemAuditRow === undefined ||
      itemAuditRow.species_slug !== "ivysaur" ||
      itemAuditRow.quantity !== "0" ||
      itemAuditRow.ledgers !== "1" ||
      itemAuditRow.claims !== "1"
    ) {
      throw new Error(`Item evolution atomicity audit failed: ${JSON.stringify(itemAuditRow)}`);
    }

    const noItemPlayer = await createPlayerPokemon(pool, itemProof.release, {
      speciesSlug: "bulbasaur",
      level: 10,
      xp: 0,
      moveSlugs: ["tackle", "growl"],
      trainerLevel: 1,
      trainerPoints: 0,
    });
    const noItem = await service.evolvePokemon({
      playerId: noItemPlayer.playerId,
      pokemonInstanceId: noItemPlayer.pokemonId,
      idempotencyKey: "phase11-no-item-evolution",
      correlationId: randomUUID(),
      trigger: { kind: "ITEM", itemId: itemProof.itemId },
    });
    expectFailure("insufficient evolution item", noItem, "EVOLUTION_ITEM_MISSING");
    const noItemAudit = await pool.query<{ species_slug: string; ledgers: string; claims: string }>(
      `SELECT species.slug AS species_slug,
              (SELECT count(*)::text FROM inventory_ledger WHERE player_id = $2 AND item_id = $3 AND source_type = 'EVOLUTION') AS ledgers,
              (SELECT count(*)::text FROM pokemon_evolution_claims WHERE pokemon_instance_id = $1 AND idempotency_scope = 'progression.evolve') AS claims
       FROM pokemon_instances instance
       JOIN pokemon_forms form ON form.id = instance.form_id
       JOIN pokemon_species species ON species.id = form.species_id
       WHERE instance.id = $1`,
      [noItemPlayer.pokemonId, noItemPlayer.playerId, itemProof.itemId],
    );
    const noItemRow = noItemAudit.rows[0];
    if (noItemRow === undefined || noItemRow.species_slug !== "bulbasaur" || noItemRow.ledgers !== "0" || noItemRow.claims !== "0") {
      throw new Error(`Missing-item evolution leaked partial state: ${JSON.stringify(noItemRow)}`);
    }

    console.log(
      `Phase 11 progression proof complete: crash rollback, reward replay/concurrency, move choice, level evolution, trainer unlocks and item evolution are atomic`,
    );
  } finally {
    await pool.end();
  }
}

await main();
