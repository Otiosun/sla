import type { Pool } from "pg";
import { EvolutionTriggerSchemas } from "../../modules/catalog/contracts.js";
import type {
  OperationalEvolutionOptionView,
  OperationalEvolutionRelativeStats,
  OperationalInventoryItemView,
  OperationalOwnedPokemonDetailView,
  OperationalOwnedPokemonView,
  OperationalPendingMoveChoiceView,
  OperationalPokedexSpeciesView,
  OperationalPokemonDetailView,
  OperationalRegionOption,
  OperationalTeamMemberView,
  OperationalUxReadModel,
} from "../../modules/messaging/operational-ux-read-model.js";
import type { PlayerId, PokemonInstanceId } from "../../shared-kernel/ids.js";
import { parsePokemonInstanceId } from "../../shared-kernel/ids.js";

function legacyLevelEvolutionConfig(config: unknown): {
  readonly level: number;
  readonly relativePhysicalStats: OperationalEvolutionRelativeStats | null;
} | null {
  if (typeof config !== "object" || config === null) return null;
  const value = config as Record<string, unknown>;
  const level = value.minimumLevel;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 2 || level > 100) {
    return null;
  }
  const relative = value.relativePhysicalStats;
  const relativePhysicalStats =
    relative === "ATTACK_GT_DEFENSE" ||
    relative === "ATTACK_LT_DEFENSE" ||
    relative === "ATTACK_EQ_DEFENSE"
      ? relative
      : null;
  return { level, relativePhysicalStats };
}

function evolutionLevelConfig(config: unknown): {
  readonly level: number;
  readonly relativePhysicalStats: OperationalEvolutionRelativeStats | null;
} | null {
  const canonical = EvolutionTriggerSchemas.LEVEL.safeParse(config);
  if (canonical.success) {
    return {
      level: canonical.data.level,
      relativePhysicalStats: canonical.data.relativePhysicalStats ?? null,
    };
  }
  return legacyLevelEvolutionConfig(config);
}

function evolutionItemId(config: unknown): string | null {
  const canonical = EvolutionTriggerSchemas.ITEM.safeParse(config);
  if (canonical.success) return canonical.data.itemId;
  if (typeof config !== "object" || config === null) return null;
  const value = (config as Record<string, unknown>).sourceItemIdentityId;
  const legacy = EvolutionTriggerSchemas.ITEM.safeParse({ itemId: value });
  return legacy.success ? legacy.data.itemId : null;
}

function evolutionConditionKey(config: unknown): string | null {
  const canonical = EvolutionTriggerSchemas.CONDITION.safeParse(config);
  return canonical.success ? canonical.data.conditionKey : null;
}

export class PostgresOperationalUxReadModel implements OperationalUxReadModel {
  public constructor(private readonly pool: Pool) {}

  public async listRegionOptions(playerId: PlayerId): Promise<readonly OperationalRegionOption[]> {
    const result = await this.pool.query<{ region_id: string; display_name: string }>(
      `SELECT revision.region_id, revision.display_name
       FROM player_onboarding_context context
       JOIN region_revisions revision
         ON revision.content_release_id = context.content_release_id
        AND revision.active = TRUE
       WHERE context.player_id = $1
       ORDER BY revision.display_name, revision.region_id`,
      [playerId],
    );
    return result.rows.map((row) => ({ regionId: row.region_id, displayName: row.display_name }));
  }

  public async listTeam(playerId: PlayerId): Promise<readonly OperationalTeamMemberView[]> {
    const result = await this.pool.query<{
      pokemon_instance_id: string;
      display_name: string;
      level: number;
      current_hp: number;
      slot_no: number;
    }>(
      `SELECT pokemon.id AS pokemon_instance_id,
              species_revision.display_name,
              pokemon.level,
              pokemon.current_hp,
              roster.slot_no
       FROM pokemon_roster_slots roster
       JOIN pokemon_instances pokemon ON pokemon.id = roster.pokemon_instance_id
       JOIN pokemon_forms form_identity ON form_identity.id = pokemon.form_id
       JOIN player_onboarding_context context ON context.player_id = roster.player_id
       JOIN pokemon_species_revisions species_revision
         ON species_revision.content_release_id = context.content_release_id
        AND species_revision.species_id = form_identity.species_id
        AND species_revision.active = TRUE
       WHERE roster.player_id = $1
         AND roster.placement_kind = 'TEAM'
         AND pokemon.status = 'ACTIVE'
       ORDER BY roster.slot_no`,
      [playerId],
    );
    return result.rows.map((row) => {
      const parsed = parsePokemonInstanceId(row.pokemon_instance_id);
      if (!parsed.ok)
        throw new Error("Operational team projection returned invalid PokemonInstanceId");
      return {
        pokemonInstanceId: parsed.value,
        displayName: row.display_name,
        level: row.level,
        currentHp: row.current_hp,
        slotNo: row.slot_no,
      };
    });
  }

  public async teamPokemonDetail(
    playerId: PlayerId,
    slotNo: number,
  ): Promise<OperationalPokemonDetailView | null> {
    const pokemon = await this.pool.query<{
      pokemon_instance_id: string;
      content_release_id: string;
      slot_no: number;
      display_name: string;
      nickname: string | null;
      level: number;
      current_hp: number;
      gender: "MALE" | "FEMALE" | null;
      shiny: boolean;
      base_hp: number;
      iv_hp: number | null;
      iv_attack: number | null;
      iv_defense: number | null;
      iv_sp_attack: number | null;
      iv_sp_defense: number | null;
      iv_speed: number | null;
      ev_hp: number | null;
      nature_display_name: string;
      ability_display_name: string;
      iv_enabled: boolean;
      ev_enabled: boolean;
    }>(
      `SELECT pokemon.id AS pokemon_instance_id,
              context.content_release_id,
              roster.slot_no,
              species_revision.display_name,
              pokemon.nickname,
              pokemon.level,
              pokemon.current_hp,
              pokemon.gender,
              pokemon.shiny,
              form_revision.base_hp,
              training.iv_hp, training.iv_attack, training.iv_defense,
              training.iv_sp_attack, training.iv_sp_defense, training.iv_speed,
              training.ev_hp,
              nature_revision.display_name AS nature_display_name,
              ability_revision.display_name AS ability_display_name,
              COALESCE((ruleset.config->'battle'->>'ivEnabled')::boolean, TRUE) AS iv_enabled,
              COALESCE((ruleset.config->'battle'->>'evEnabled')::boolean, FALSE) AS ev_enabled
       FROM pokemon_roster_slots roster
       JOIN pokemon_instances pokemon
         ON pokemon.id = roster.pokemon_instance_id
        AND pokemon.owner_player_id = roster.player_id
       JOIN player_onboarding_context context ON context.player_id = roster.player_id
       JOIN content_releases release ON release.id = context.content_release_id
       JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
       JOIN pokemon_forms form_identity ON form_identity.id = pokemon.form_id
       JOIN pokemon_form_revisions form_revision
         ON form_revision.content_release_id = context.content_release_id
        AND form_revision.form_id = pokemon.form_id
        AND form_revision.active = TRUE
       JOIN pokemon_species_revisions species_revision
         ON species_revision.content_release_id = context.content_release_id
        AND species_revision.species_id = form_identity.species_id
        AND species_revision.active = TRUE
       JOIN pokemon_training_values training ON training.pokemon_instance_id = pokemon.id
       JOIN nature_revisions nature_revision
         ON nature_revision.content_release_id = context.content_release_id
        AND nature_revision.nature_id = training.nature_id
        AND nature_revision.active = TRUE
       JOIN ability_revisions ability_revision
         ON ability_revision.content_release_id = context.content_release_id
        AND ability_revision.ability_id = pokemon.ability_id
        AND ability_revision.active = TRUE
       WHERE roster.player_id = $1
         AND roster.placement_kind = 'TEAM'
         AND roster.slot_no = $2
         AND pokemon.status = 'ACTIVE'
       LIMIT 1`,
      [playerId, slotNo],
    );
    const row = pokemon.rows[0];
    if (row === undefined) return null;
    const parsed = parsePokemonInstanceId(row.pokemon_instance_id);
    if (!parsed.ok) throw new Error("Pokemon detail projection returned invalid PokemonInstanceId");

    const [moves, conditions] = await Promise.all([
      this.pool.query<{
        slot_no: number;
        display_name: string;
        pp_current: number | null;
        max_pp: number | null;
      }>(
        `SELECT slot.slot_no, revision.display_name, slot.pp_current, revision.max_pp
         FROM pokemon_move_slots slot
         JOIN move_revisions revision
           ON revision.content_release_id = $2
          AND revision.move_id = slot.move_id
          AND revision.active = TRUE
         WHERE slot.pokemon_instance_id = $1
         ORDER BY slot.slot_no`,
        [row.pokemon_instance_id, row.content_release_id],
      ),
      this.pool.query<{ condition_key: string }>(
        `SELECT condition_key
         FROM pokemon_persistent_conditions
         WHERE pokemon_instance_id = $1
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY condition_key`,
        [row.pokemon_instance_id],
      ),
    ]);

    const ivHp = row.iv_enabled ? (row.iv_hp ?? 0) : 0;
    const evHp = row.ev_enabled ? (row.ev_hp ?? 0) : 0;
    const maxHp =
      Math.floor(((2 * row.base_hp + ivHp + Math.floor(evHp / 4)) * row.level) / 100) +
      row.level +
      10;

    return {
      pokemonInstanceId: parsed.value,
      slotNo: row.slot_no,
      displayName: row.display_name,
      nickname: row.nickname,
      level: row.level,
      currentHp: row.current_hp,
      maxHp,
      gender: row.gender,
      shiny: row.shiny,
      natureDisplayName: row.nature_display_name,
      abilityDisplayName: row.ability_display_name,
      ivs: {
        hp: row.iv_hp ?? 0,
        attack: row.iv_attack ?? 0,
        defense: row.iv_defense ?? 0,
        spAttack: row.iv_sp_attack ?? 0,
        spDefense: row.iv_sp_defense ?? 0,
        speed: row.iv_speed ?? 0,
      },
      statuses: conditions.rows.map((condition) => condition.condition_key),
      moves: moves.rows.map((move) => ({
        slotNo: move.slot_no,
        displayName: move.display_name,
        ppCurrent: move.pp_current,
        maxPp: move.max_pp,
      })),
    };
  }
  public async listOwnedPokemon(
    playerId: PlayerId,
  ): Promise<readonly OperationalOwnedPokemonView[]> {
    const result = await this.pool.query<{
      collection_no: number;
      pokemon_instance_id: string;
      display_name: string;
      nickname: string | null;
      level: number;
      xp: string;
      current_hp: number;
      placement_kind: "TEAM" | "BOX";
      box_no: number | null;
      slot_no: number;
    }>(
      `WITH ranked AS (
         SELECT pokemon.*,
                row_number() OVER (ORDER BY pokemon.created_at, pokemon.id)::int AS collection_no
         FROM pokemon_instances pokemon
         WHERE pokemon.owner_player_id = $1
       )
       SELECT ranked.collection_no,
              ranked.id AS pokemon_instance_id,
              species_revision.display_name,
              ranked.nickname,
              ranked.level,
              ranked.xp::text,
              ranked.current_hp,
              roster.placement_kind,
              roster.box_no,
              roster.slot_no
       FROM ranked
       JOIN pokemon_roster_slots roster
         ON roster.player_id = $1
        AND roster.pokemon_instance_id = ranked.id
       JOIN pokemon_forms form_identity ON form_identity.id = ranked.form_id
       JOIN player_onboarding_context context ON context.player_id = $1
       JOIN pokemon_species_revisions species_revision
         ON species_revision.content_release_id = context.content_release_id
        AND species_revision.species_id = form_identity.species_id
        AND species_revision.active = TRUE
       WHERE ranked.status = 'ACTIVE'
       ORDER BY ranked.collection_no`,
      [playerId],
    );
    return result.rows.map((row) => {
      const parsed = parsePokemonInstanceId(row.pokemon_instance_id);
      if (!parsed.ok)
        throw new Error("Owned Pokemon projection returned invalid PokemonInstanceId");
      return {
        collectionNo: row.collection_no,
        pokemonInstanceId: parsed.value,
        displayName: row.display_name,
        nickname: row.nickname,
        level: row.level,
        xp: BigInt(row.xp),
        currentHp: row.current_hp,
        placementKind: row.placement_kind,
        boxNo: row.box_no,
        slotNo: row.slot_no,
      };
    });
  }

  public async ownedPokemonDetail(
    playerId: PlayerId,
    collectionNo: number,
  ): Promise<OperationalOwnedPokemonDetailView | null> {
    const pokemon = await this.pool.query<{
      collection_no: number;
      pokemon_instance_id: string;
      content_release_id: string;
      placement_kind: "TEAM" | "BOX";
      box_no: number | null;
      slot_no: number;
      display_name: string;
      nickname: string | null;
      level: number;
      xp: string;
      current_hp: number;
      gender: "MALE" | "FEMALE" | null;
      shiny: boolean;
      base_hp: number;
      iv_hp: number | null;
      iv_attack: number | null;
      iv_defense: number | null;
      iv_sp_attack: number | null;
      iv_sp_defense: number | null;
      iv_speed: number | null;
      ev_hp: number | null;
      nature_display_name: string;
      ability_display_name: string;
      iv_enabled: boolean;
      ev_enabled: boolean;
    }>(
      `WITH ranked AS (
         SELECT pokemon.*,
                row_number() OVER (ORDER BY pokemon.created_at, pokemon.id)::int AS collection_no
         FROM pokemon_instances pokemon
         WHERE pokemon.owner_player_id = $1
       )
       SELECT ranked.collection_no,
              ranked.id AS pokemon_instance_id,
              context.content_release_id,
              roster.placement_kind,
              roster.box_no,
              roster.slot_no,
              species_revision.display_name,
              ranked.nickname,
              ranked.level,
              ranked.xp::text,
              ranked.current_hp,
              ranked.gender,
              ranked.shiny,
              form_revision.base_hp,
              training.iv_hp, training.iv_attack, training.iv_defense,
              training.iv_sp_attack, training.iv_sp_defense, training.iv_speed,
              training.ev_hp,
              nature_revision.display_name AS nature_display_name,
              ability_revision.display_name AS ability_display_name,
              COALESCE((ruleset.config->'battle'->>'ivEnabled')::boolean, TRUE) AS iv_enabled,
              COALESCE((ruleset.config->'battle'->>'evEnabled')::boolean, FALSE) AS ev_enabled
       FROM ranked
       JOIN pokemon_roster_slots roster
         ON roster.player_id = $1
        AND roster.pokemon_instance_id = ranked.id
       JOIN player_onboarding_context context ON context.player_id = $1
       JOIN content_releases release ON release.id = context.content_release_id
       JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
       JOIN pokemon_forms form_identity ON form_identity.id = ranked.form_id
       JOIN pokemon_form_revisions form_revision
         ON form_revision.content_release_id = context.content_release_id
        AND form_revision.form_id = ranked.form_id
        AND form_revision.active = TRUE
       JOIN pokemon_species_revisions species_revision
         ON species_revision.content_release_id = context.content_release_id
        AND species_revision.species_id = form_identity.species_id
        AND species_revision.active = TRUE
       JOIN pokemon_training_values training ON training.pokemon_instance_id = ranked.id
       JOIN nature_revisions nature_revision
         ON nature_revision.content_release_id = context.content_release_id
        AND nature_revision.nature_id = training.nature_id
        AND nature_revision.active = TRUE
       JOIN ability_revisions ability_revision
         ON ability_revision.content_release_id = context.content_release_id
        AND ability_revision.ability_id = ranked.ability_id
        AND ability_revision.active = TRUE
       WHERE ranked.collection_no = $2
         AND ranked.status = 'ACTIVE'
       LIMIT 1`,
      [playerId, collectionNo],
    );
    const row = pokemon.rows[0];
    if (row === undefined) return null;
    const parsed = parsePokemonInstanceId(row.pokemon_instance_id);
    if (!parsed.ok) throw new Error("Owned Pokemon detail returned invalid PokemonInstanceId");

    const [moves, conditions] = await Promise.all([
      this.pool.query<{
        slot_no: number;
        display_name: string;
        pp_current: number | null;
        max_pp: number | null;
      }>(
        `SELECT slot.slot_no, revision.display_name, slot.pp_current, revision.max_pp
         FROM pokemon_move_slots slot
         JOIN move_revisions revision
           ON revision.content_release_id = $2
          AND revision.move_id = slot.move_id
          AND revision.active = TRUE
         WHERE slot.pokemon_instance_id = $1
         ORDER BY slot.slot_no`,
        [row.pokemon_instance_id, row.content_release_id],
      ),
      this.pool.query<{ condition_key: string }>(
        `SELECT condition_key
         FROM pokemon_persistent_conditions
         WHERE pokemon_instance_id = $1
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY condition_key`,
        [row.pokemon_instance_id],
      ),
    ]);

    const ivHp = row.iv_enabled ? (row.iv_hp ?? 0) : 0;
    const evHp = row.ev_enabled ? (row.ev_hp ?? 0) : 0;
    const maxHp =
      Math.floor(((2 * row.base_hp + ivHp + Math.floor(evHp / 4)) * row.level) / 100) +
      row.level +
      10;

    return {
      collectionNo: row.collection_no,
      pokemonInstanceId: parsed.value,
      placementKind: row.placement_kind,
      boxNo: row.box_no,
      slotNo: row.slot_no,
      displayName: row.display_name,
      nickname: row.nickname,
      level: row.level,
      xp: BigInt(row.xp),
      currentHp: row.current_hp,
      maxHp,
      gender: row.gender,
      shiny: row.shiny,
      natureDisplayName: row.nature_display_name,
      abilityDisplayName: row.ability_display_name,
      ivs: {
        hp: row.iv_hp ?? 0,
        attack: row.iv_attack ?? 0,
        defense: row.iv_defense ?? 0,
        spAttack: row.iv_sp_attack ?? 0,
        spDefense: row.iv_sp_defense ?? 0,
        speed: row.iv_speed ?? 0,
      },
      statuses: conditions.rows.map((condition) => condition.condition_key),
      moves: moves.rows.map((move) => ({
        slotNo: move.slot_no,
        displayName: move.display_name,
        ppCurrent: move.pp_current,
        maxPp: move.max_pp,
      })),
    };
  }

  public async listInventory(playerId: PlayerId): Promise<readonly OperationalInventoryItemView[]> {
    const result = await this.pool.query<{
      item_id: string;
      item_slug: string;
      display_name: string;
      quantity: string;
    }>(
      `SELECT balance.item_id,
              identity.slug AS item_slug,
              revision.display_name,
              balance.quantity::text
       FROM inventory_balances balance
       JOIN items identity ON identity.id = balance.item_id
       JOIN player_onboarding_context context ON context.player_id = balance.player_id
       JOIN item_revisions revision
         ON revision.content_release_id = context.content_release_id
        AND revision.item_id = balance.item_id
        AND revision.active = TRUE
       WHERE balance.player_id = $1 AND balance.quantity > 0
       ORDER BY revision.display_name, balance.item_id`,
      [playerId],
    );
    return result.rows.map((row) => ({
      itemId: row.item_id,
      itemSlug: row.item_slug,
      displayName: row.display_name,
      quantity: BigInt(row.quantity),
    }));
  }

  public async listPokedex(playerId: PlayerId): Promise<readonly OperationalPokedexSpeciesView[]> {
    const result = await this.pool.query<{
      species_id: string;
      national_dex: number;
      species_slug: string;
      display_name: string;
      seen_count: string;
      caught_count: string;
    }>(
      `SELECT dex.species_id,
              identity.national_dex,
              identity.slug AS species_slug,
              revision.display_name,
              dex.seen_count::text,
              dex.caught_count::text
       FROM player_pokedex_species dex
       JOIN pokemon_species identity ON identity.id = dex.species_id
       JOIN player_onboarding_context context ON context.player_id = dex.player_id
       JOIN pokemon_species_revisions revision
         ON revision.content_release_id = context.content_release_id
        AND revision.species_id = dex.species_id
        AND revision.active = TRUE
       WHERE dex.player_id = $1 AND dex.seen_count > 0
       ORDER BY identity.national_dex, dex.species_id`,
      [playerId],
    );
    return result.rows.map((row) => ({
      speciesId: row.species_id,
      nationalDex: row.national_dex,
      speciesSlug: row.species_slug,
      displayName: row.display_name,
      seenCount: BigInt(row.seen_count),
      caughtCount: BigInt(row.caught_count),
    }));
  }

  public async listPendingMoveChoices(
    playerId: PlayerId,
  ): Promise<readonly OperationalPendingMoveChoiceView[]> {
    const result = await this.pool.query<{
      choice_id: string;
      pokemon_instance_id: string;
      pokemon_display_name: string;
      learn_level: number;
      move_id: string;
      move_display_name: string;
      slot_no: number | null;
      current_move_id: string | null;
      current_move_display_name: string | null;
    }>(
      `SELECT choice.id AS choice_id,
              choice.pokemon_instance_id,
              species_revision.display_name AS pokemon_display_name,
              choice.learn_level,
              choice.move_id,
              pending_move_revision.display_name AS move_display_name,
              slot.slot_no,
              slot.move_id AS current_move_id,
              current_move_revision.display_name AS current_move_display_name
       FROM pending_move_choices choice
       JOIN pokemon_instances pokemon
         ON pokemon.id = choice.pokemon_instance_id
        AND pokemon.owner_player_id = $1
       JOIN pokemon_forms form_identity ON form_identity.id = pokemon.form_id
       JOIN pokemon_species_revisions species_revision
         ON species_revision.content_release_id = choice.content_release_id
        AND species_revision.species_id = form_identity.species_id
        AND species_revision.active = TRUE
       JOIN move_revisions pending_move_revision
         ON pending_move_revision.content_release_id = choice.content_release_id
        AND pending_move_revision.move_id = choice.move_id
        AND pending_move_revision.active = TRUE
       LEFT JOIN pokemon_move_slots slot
         ON slot.pokemon_instance_id = choice.pokemon_instance_id
       LEFT JOIN move_revisions current_move_revision
         ON current_move_revision.content_release_id = choice.content_release_id
        AND current_move_revision.move_id = slot.move_id
        AND current_move_revision.active = TRUE
       WHERE choice.status = 'PENDING'
       ORDER BY choice.id, slot.slot_no`,
      [playerId],
    );

    const grouped = new Map<string, OperationalPendingMoveChoiceView>();
    for (const row of result.rows) {
      let view = grouped.get(row.choice_id);
      if (view === undefined) {
        const parsed = parsePokemonInstanceId(row.pokemon_instance_id);
        if (!parsed.ok) {
          throw new Error("Pending move projection returned invalid PokemonInstanceId");
        }
        view = {
          choiceId: row.choice_id,
          pokemonInstanceId: parsed.value,
          pokemonDisplayName: row.pokemon_display_name,
          learnLevel: row.learn_level,
          moveId: row.move_id,
          moveDisplayName: row.move_display_name,
          currentMoves: [],
        };
        grouped.set(row.choice_id, view);
      }
      if (
        row.slot_no !== null &&
        row.current_move_id !== null &&
        row.current_move_display_name !== null
      ) {
        (
          view.currentMoves as Array<{
            slotNo: number;
            moveId: string;
            displayName: string;
          }>
        ).push({
          slotNo: row.slot_no,
          moveId: row.current_move_id,
          displayName: row.current_move_display_name,
        });
      }
    }
    return [...grouped.values()];
  }

  public async listEvolutionOptions(
    playerId: PlayerId,
    pokemonInstanceId: PokemonInstanceId,
  ): Promise<readonly OperationalEvolutionOptionView[]> {
    const rules = await this.pool.query<{
      content_release_id: string;
      trigger_kind: "LEVEL" | "ITEM" | "CONDITION";
      trigger_config: unknown;
      target_display_name: string;
    }>(
      `SELECT context.content_release_id,
              rule.trigger_kind,
              rule.trigger_config,
              target_species_revision.display_name AS target_display_name
       FROM pokemon_instances pokemon
       JOIN player_onboarding_context context
         ON context.player_id = pokemon.owner_player_id
       JOIN evolution_rules rule
         ON rule.content_release_id = context.content_release_id
        AND rule.from_form_id = pokemon.form_id
        AND rule.active = TRUE
       JOIN pokemon_forms target_form
         ON target_form.id = rule.to_form_id
       JOIN pokemon_species_revisions target_species_revision
         ON target_species_revision.content_release_id = context.content_release_id
        AND target_species_revision.species_id = target_form.species_id
        AND target_species_revision.active = TRUE
       WHERE pokemon.owner_player_id = $1
         AND pokemon.id = $2
         AND pokemon.status = 'ACTIVE'
       ORDER BY CASE rule.trigger_kind WHEN 'LEVEL' THEN 1 WHEN 'ITEM' THEN 2 ELSE 3 END,
                target_species_revision.display_name,
                rule.id`,
      [playerId, pokemonInstanceId],
    );

    const options: OperationalEvolutionOptionView[] = [];
    for (const rule of rules.rows) {
      if (rule.trigger_kind === "LEVEL") {
        const parsed = evolutionLevelConfig(rule.trigger_config);
        if (parsed === null) continue;
        options.push({
          targetDisplayName: rule.target_display_name,
          triggerKind: "LEVEL",
          requiredLevel: parsed.level,
          relativePhysicalStats: parsed.relativePhysicalStats,
          itemId: null,
          itemDisplayName: null,
          itemQuantity: null,
          conditionActive: null,
        });
        continue;
      }

      if (rule.trigger_kind === "ITEM") {
        const itemId = evolutionItemId(rule.trigger_config);
        if (itemId === null) continue;
        const item = await this.pool.query<{ display_name: string; quantity: string }>(
          `SELECT revision.display_name,
                  COALESCE(balance.quantity, 0)::text AS quantity
           FROM item_revisions revision
           LEFT JOIN inventory_balances balance
             ON balance.player_id = $1
            AND balance.item_id = revision.item_id
           WHERE revision.content_release_id = $2
             AND revision.item_id = $3
             AND revision.active = TRUE
           LIMIT 1`,
          [playerId, rule.content_release_id, itemId],
        );
        const itemRow = item.rows[0];
        if (itemRow === undefined) continue;
        options.push({
          targetDisplayName: rule.target_display_name,
          triggerKind: "ITEM",
          requiredLevel: null,
          relativePhysicalStats: null,
          itemId,
          itemDisplayName: itemRow.display_name,
          itemQuantity: BigInt(itemRow.quantity),
          conditionActive: null,
        });
        continue;
      }

      const conditionKey = evolutionConditionKey(rule.trigger_config);
      if (conditionKey === null) continue;
      const active = await this.pool.query<{ active: boolean }>(
        `SELECT EXISTS(
           SELECT 1
           FROM pokemon_evolution_condition_flags flag
           WHERE flag.pokemon_instance_id = $1
             AND flag.condition_key = $2
             AND flag.status = 'ACTIVE'
         ) AS active`,
        [pokemonInstanceId, conditionKey],
      );
      options.push({
        targetDisplayName: rule.target_display_name,
        triggerKind: "CONDITION",
        requiredLevel: null,
        relativePhysicalStats: null,
        itemId: null,
        itemDisplayName: null,
        itemQuantity: null,
        conditionActive: active.rows[0]?.active === true,
      });
    }
    return options;
  }

  public async activeBattleId(playerId: PlayerId): Promise<string | null> {
    const result = await this.pool.query<{ battle_id: string }>(
      `SELECT battle.id AS battle_id
       FROM battles battle
       LEFT JOIN battle_sides side ON side.battle_id = battle.id
       LEFT JOIN battle_participant_controllers controller ON controller.battle_id = battle.id
       WHERE (side.player_id = $1 OR controller.player_id = $1)
         AND battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
       ORDER BY battle.created_at DESC, battle.id DESC
       LIMIT 1`,
      [playerId],
    );
    return result.rows[0]?.battle_id ?? null;
  }

  public async speciesDisplayName(
    contentReleaseId: string,
    speciesId: string,
  ): Promise<string | null> {
    const result = await this.pool.query<{ display_name: string }>(
      `SELECT display_name
       FROM pokemon_species_revisions
       WHERE content_release_id = $1 AND species_id = $2 AND active = TRUE`,
      [contentReleaseId, speciesId],
    );
    return result.rows[0]?.display_name ?? null;
  }

  public async moveDisplayNames(
    contentReleaseId: string,
    moveIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (moveIds.length === 0) return new Map();
    const result = await this.pool.query<{ move_id: string; display_name: string }>(
      `SELECT move_id, display_name
       FROM move_revisions
       WHERE content_release_id = $1
         AND move_id = ANY($2::uuid[])
         AND active = TRUE`,
      [contentReleaseId, [...new Set(moveIds)]],
    );
    return new Map(result.rows.map((row) => [row.move_id, row.display_name] as const));
  }
}
