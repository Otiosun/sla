import type { Pool } from "pg";
import { BattleStateSchema } from "../../modules/battle/contracts.js";
import { pokemonXpRequiredForNextLevel } from "../../modules/progression/rules.js";
import type {
  PlayerPortalActiveBattleRecord,
  PlayerPortalInventoryItemView,
  PlayerPortalMoveView,
  PlayerPortalPokedexSpeciesView,
  PlayerPortalPokemonView,
  PlayerPortalReadRepository,
} from "../../modules/player-portal/read-service.js";
import type { PlayerId, PokemonInstanceId } from "../../shared-kernel/ids.js";
import { parsePokemonInstanceId } from "../../shared-kernel/ids.js";

interface OwnedPokemonRow {
  readonly pokemon_instance_id: string;
  readonly form_id: string;
  readonly display_name: string | null;
  readonly national_dex: number | null;
  readonly type1_name: string | null;
  readonly type2_name: string | null;
  readonly nickname: string | null;
  readonly level: number;
  readonly xp: string;
  readonly current_hp: number;
  readonly nature_display_name: string | null;
  readonly ability_display_name: string | null;
  readonly gender: string | null;
  readonly shiny: boolean;
  readonly placement_kind: "TEAM" | "BOX";
  readonly box_no: number | null;
  readonly slot_no: number;
  readonly base_hp: number | null;
  readonly iv_hp: number | null;
  readonly iv_attack: number | null;
  readonly iv_defense: number | null;
  readonly iv_sp_attack: number | null;
  readonly iv_sp_defense: number | null;
  readonly iv_speed: number | null;
  readonly ev_hp: number | null;
  readonly iv_enabled: boolean;
  readonly ev_enabled: boolean;
}

interface MoveRow {
  readonly pokemon_instance_id: string;
  readonly slot_no: number;
  readonly move_id: string;
  readonly display_name: string | null;
  readonly type_name: string | null;
  readonly category: "PHYSICAL" | "SPECIAL" | "STATUS" | null;
  readonly power: number | null;
  readonly accuracy: number | null;
  readonly pp_current: number | null;
  readonly max_pp: number | null;
}

function pokemonId(value: string): PokemonInstanceId {
  const parsed = parsePokemonInstanceId(value);
  if (!parsed.ok) throw new Error("Player Portal projection returned invalid PokemonInstanceId");
  return parsed.value;
}

function maxHp(row: OwnedPokemonRow): number | null {
  if (row.base_hp === null) return null;
  const iv = row.iv_enabled ? (row.iv_hp ?? 0) : 0;
  const ev = row.ev_enabled ? (row.ev_hp ?? 0) : 0;
  return (
    Math.floor(((2 * row.base_hp + iv + Math.floor(ev / 4)) * row.level) / 100) +
    row.level +
    10
  );
}

export class PostgresPlayerPortalReadRepository implements PlayerPortalReadRepository {
  public constructor(private readonly pool: Pool) {}

  public async originRegionDisplayName(
    contentReleaseId: string,
    originRegionId: string | null,
  ): Promise<string | null> {
    if (originRegionId === null) return null;
    const result = await this.pool.query<{ display_name: string }>(
      `SELECT display_name
       FROM region_revisions
       WHERE content_release_id = $1
         AND region_id = $2
         AND active = TRUE
       LIMIT 1`,
      [contentReleaseId, originRegionId],
    );
    return result.rows[0]?.display_name ?? null;
  }

  public async listOwnedPokemon(
    playerId: PlayerId,
    contentReleaseId: string,
  ): Promise<readonly PlayerPortalPokemonView[]> {
    const pokemon = await this.pool.query<OwnedPokemonRow>(
      `SELECT
         instance.id::text AS pokemon_instance_id,
         instance.form_id::text AS form_id,
         form_revision.display_name,
         species.national_dex,
         type1_revision.display_name AS type1_name,
         type2_revision.display_name AS type2_name,
         instance.nickname,
         instance.level,
         instance.xp::text AS xp,
         instance.current_hp,
         nature_revision.display_name AS nature_display_name,
         ability_revision.display_name AS ability_display_name,
         instance.gender,
         instance.shiny,
         roster.placement_kind,
         roster.box_no,
         roster.slot_no,
         form_revision.base_hp,
         training.iv_hp,
         training.iv_attack,
         training.iv_defense,
         training.iv_sp_attack,
         training.iv_sp_defense,
         training.iv_speed,
         training.ev_hp,
         COALESCE((ruleset.config->'battle'->>'ivEnabled')::boolean, TRUE) AS iv_enabled,
         COALESCE((ruleset.config->'battle'->>'evEnabled')::boolean, FALSE) AS ev_enabled
       FROM pokemon_instances instance
       JOIN content_releases release
         ON release.id = $2
       JOIN rulesets ruleset
         ON ruleset.id = release.default_ruleset_id
       JOIN pokemon_roster_slots roster
         ON roster.pokemon_instance_id = instance.id
        AND roster.player_id = instance.owner_player_id
       JOIN pokemon_forms form_identity ON form_identity.id = instance.form_id
       JOIN pokemon_species species ON species.id = form_identity.species_id
       LEFT JOIN pokemon_form_revisions form_revision
         ON form_revision.content_release_id = $2
        AND form_revision.form_id = instance.form_id
        AND form_revision.active = TRUE
       LEFT JOIN pokemon_type_revisions type1_revision
         ON type1_revision.content_release_id = $2
        AND type1_revision.type_id = form_revision.type1_id
        AND type1_revision.active = TRUE
       LEFT JOIN pokemon_type_revisions type2_revision
         ON type2_revision.content_release_id = $2
        AND type2_revision.type_id = form_revision.type2_id
        AND type2_revision.active = TRUE
       LEFT JOIN pokemon_training_values training
         ON training.pokemon_instance_id = instance.id
       LEFT JOIN nature_revisions nature_revision
         ON nature_revision.content_release_id = $2
        AND nature_revision.nature_id = training.nature_id
        AND nature_revision.active = TRUE
       LEFT JOIN ability_revisions ability_revision
         ON ability_revision.content_release_id = $2
        AND ability_revision.ability_id = instance.ability_id
        AND ability_revision.active = TRUE
       WHERE instance.owner_player_id = $1
         AND instance.status = 'ACTIVE'
       ORDER BY CASE roster.placement_kind WHEN 'TEAM' THEN 0 ELSE 1 END,
                roster.box_no NULLS FIRST,
                roster.slot_no,
                instance.id`,
      [playerId, contentReleaseId],
    );

    if (pokemon.rows.length === 0) return [];

    const ids = pokemon.rows.map((row) => row.pokemon_instance_id);
    const [moves, conditions] = await Promise.all([
      this.pool.query<MoveRow>(
        `SELECT
           slot.pokemon_instance_id::text,
           slot.slot_no,
           slot.move_id::text,
           revision.display_name,
           type_revision.display_name AS type_name,
           revision.category,
           revision.power,
           revision.accuracy,
           slot.pp_current,
           revision.max_pp
         FROM pokemon_move_slots slot
         LEFT JOIN move_revisions revision
           ON revision.content_release_id = $2
          AND revision.move_id = slot.move_id
          AND revision.active = TRUE
         LEFT JOIN pokemon_type_revisions type_revision
           ON type_revision.content_release_id = $2
          AND type_revision.type_id = revision.type_id
          AND type_revision.active = TRUE
         WHERE slot.pokemon_instance_id = ANY($1::uuid[])
         ORDER BY slot.pokemon_instance_id, slot.slot_no`,
        [ids, contentReleaseId],
      ),
      this.pool.query<{ pokemon_instance_id: string; condition_key: string }>(
        `SELECT pokemon_instance_id::text, condition_key
         FROM pokemon_persistent_conditions
         WHERE pokemon_instance_id = ANY($1::uuid[])
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY pokemon_instance_id, condition_key`,
        [ids],
      ),
    ]);

    const movesByPokemon = new Map<string, PlayerPortalMoveView[]>();
    for (const row of moves.rows) {
      const entries = movesByPokemon.get(row.pokemon_instance_id) ?? [];
      entries.push({
        slotNo: row.slot_no,
        moveId: row.move_id,
        displayName: row.display_name,
        typeName: row.type_name,
        category: row.category,
        power: row.power,
        accuracy: row.accuracy,
        ppCurrent: row.pp_current,
        maxPp: row.max_pp,
      });
      movesByPokemon.set(row.pokemon_instance_id, entries);
    }

    const conditionsByPokemon = new Map<string, string[]>();
    for (const row of conditions.rows) {
      const entries = conditionsByPokemon.get(row.pokemon_instance_id) ?? [];
      entries.push(row.condition_key);
      conditionsByPokemon.set(row.pokemon_instance_id, entries);
    }

    return pokemon.rows.map((row) => ({
      pokemonInstanceId: pokemonId(row.pokemon_instance_id),
      formId: row.form_id,
      displayName: row.display_name,
      nationalDex: row.national_dex,
      typeNames:
        row.type1_name === null
          ? []
          : row.type2_name === null
            ? [row.type1_name]
            : [row.type1_name, row.type2_name],
      nickname: row.nickname,
      level: row.level,
      xp: row.xp,
      xpToNextLevel: pokemonXpRequiredForNextLevel(row.level),
      currentHp: row.current_hp,
      maxHp: maxHp(row),
      natureDisplayName: row.nature_display_name,
      abilityDisplayName: row.ability_display_name,
      ivs: {
        hp: row.iv_hp,
        attack: row.iv_attack,
        defense: row.iv_defense,
        spAttack: row.iv_sp_attack,
        spDefense: row.iv_sp_defense,
        speed: row.iv_speed,
      },
      gender: row.gender,
      shiny: row.shiny,
      placementKind: row.placement_kind,
      boxNo: row.box_no,
      slotNo: row.slot_no,
      conditions: conditionsByPokemon.get(row.pokemon_instance_id) ?? [],
      moves: movesByPokemon.get(row.pokemon_instance_id) ?? [],
    }));
  }

  public async listPokedex(
    playerId: PlayerId,
    contentReleaseId: string,
  ): Promise<readonly PlayerPortalPokedexSpeciesView[]> {
    const result = await this.pool.query<{
      species_id: string;
      national_dex: number;
      species_slug: string;
      display_name: string;
      seen_count: string;
      caught_count: string;
      first_seen_at: Date | null;
      last_seen_at: Date | null;
      first_caught_at: Date | null;
      last_caught_at: Date | null;
    }>(
      `SELECT
         dex.species_id::text,
         identity.national_dex,
         identity.slug AS species_slug,
         revision.display_name,
         dex.seen_count::text,
         dex.caught_count::text,
         dex.first_seen_at,
         dex.last_seen_at,
         dex.first_caught_at,
         dex.last_caught_at
       FROM player_pokedex_species dex
       JOIN pokemon_species identity ON identity.id = dex.species_id
       JOIN pokemon_species_revisions revision
         ON revision.content_release_id = $2
        AND revision.species_id = dex.species_id
        AND revision.active = TRUE
       WHERE dex.player_id = $1
         AND dex.seen_count > 0
       ORDER BY identity.national_dex, dex.species_id`,
      [playerId, contentReleaseId],
    );

    return result.rows.map((row) => ({
      speciesId: row.species_id,
      nationalDex: row.national_dex,
      speciesSlug: row.species_slug,
      displayName: row.display_name,
      seenCount: row.seen_count,
      caughtCount: row.caught_count,
      firstSeenAt: row.first_seen_at?.toISOString() ?? null,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      firstCaughtAt: row.first_caught_at?.toISOString() ?? null,
      lastCaughtAt: row.last_caught_at?.toISOString() ?? null,
    }));
  }

  public async listInventory(
    playerId: PlayerId,
    contentReleaseId: string,
  ): Promise<readonly PlayerPortalInventoryItemView[]> {
    const result = await this.pool.query<{
      item_id: string;
      item_slug: string;
      display_name: string;
      quantity: string;
    }>(
      `SELECT
         balance.item_id::text,
         identity.slug AS item_slug,
         revision.display_name,
         balance.quantity::text
       FROM inventory_balances balance
       JOIN items identity ON identity.id = balance.item_id
       JOIN item_revisions revision
         ON revision.content_release_id = $2
        AND revision.item_id = balance.item_id
        AND revision.active = TRUE
       WHERE balance.player_id = $1
         AND balance.quantity > 0
       ORDER BY revision.display_name, balance.item_id`,
      [playerId, contentReleaseId],
    );

    return result.rows.map((row) => ({
      itemId: row.item_id,
      itemSlug: row.item_slug,
      displayName: row.display_name,
      quantity: row.quantity,
    }));
  }

  public async activeBattle(playerId: PlayerId): Promise<PlayerPortalActiveBattleRecord | null> {
    const battle = await this.pool.query<{
      battle_id: string;
      state: unknown;
    }>(
      `SELECT battle.id::text AS battle_id, snapshot.state
       FROM battles battle
       JOIN battle_state_snapshots snapshot
         ON snapshot.battle_id = battle.id
        AND snapshot.version = battle.version
       WHERE battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
         AND (
           EXISTS (
             SELECT 1
             FROM battle_sides side
             WHERE side.battle_id = battle.id
               AND side.player_id = $1
           )
           OR EXISTS (
             SELECT 1
             FROM battle_participant_controllers controller
             WHERE controller.battle_id = battle.id
               AND controller.kind = 'PLAYER'
               AND controller.player_id = $1
           )
         )
       ORDER BY battle.created_at DESC, battle.id DESC
       LIMIT 1`,
      [playerId],
    );

    const row = battle.rows[0];
    if (row === undefined) return null;

    const side = await this.pool.query<{ side_no: number }>(
      `SELECT side_no
       FROM (
         SELECT side.side_no, 0 AS priority
         FROM battle_sides side
         WHERE side.battle_id = $1
           AND side.player_id = $2
         UNION
         SELECT side.side_no, 1 AS priority
         FROM battle_participant_controllers controller
         JOIN battle_participants participant
           ON participant.id = controller.participant_id
          AND participant.battle_id = controller.battle_id
         JOIN battle_sides side
           ON side.id = participant.battle_side_id
          AND side.battle_id = participant.battle_id
         WHERE controller.battle_id = $1
           AND controller.kind = 'PLAYER'
           AND controller.player_id = $2
       ) owned
       ORDER BY priority, side_no
       LIMIT 1`,
      [row.battle_id, playerId],
    );

    const sideNo = side.rows[0]?.side_no;
    if (sideNo === undefined) {
      throw new Error("Player Portal active battle has no player-owned side");
    }

    const parsed = BattleStateSchema.safeParse(row.state);
    if (!parsed.success) {
      throw new Error("Player Portal active battle snapshot is invalid");
    }

    return { state: parsed.data, playerSideNo: sideNo };
  }
}
