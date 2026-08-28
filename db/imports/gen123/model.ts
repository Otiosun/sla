import {
  type CsvRow,
  GEN123_SOURCE,
  type Gen123Source,
  optionalInt,
  requiredInt,
  requiredText,
} from "./source.js";

export interface Gen123Species {
  readonly sourceSpeciesId: number;
  readonly sourcePokemonId: number;
  readonly slug: string;
  readonly generationId: number;
  readonly captureRate: number;
  readonly genderRate: number | null;
  readonly baseExperience: number;
  readonly height: number;
  readonly weight: number;
  readonly stats: readonly [number, number, number, number, number, number];
  readonly typeIds: readonly number[];
  readonly abilitySlots: readonly { abilityId: number; slot: number; hidden: boolean }[];
}

export interface Gen123Move {
  readonly sourceId: number;
  readonly slug: string;
  readonly typeId: number;
  readonly damageClassId: number;
  readonly power: number | null;
  readonly accuracy: number | null;
  readonly priority: number;
  readonly pp: number;
  readonly effectId: number;
  readonly effectChance: number | null;
}

export interface Gen123LearnsetEntry {
  readonly speciesId: number;
  readonly moveId: number;
  readonly methodId: number;
  readonly level: number;
  readonly versionGroupIds: readonly number[];
}

export interface Gen123Evolution {
  readonly fromSpeciesId: number;
  readonly toSpeciesId: number;
  readonly triggerId: number;
  readonly itemId: number | null;
  readonly minimumLevel: number | null;
  readonly config: Readonly<Record<string, string | number | boolean | null>>;
}

export interface Gen123EncounterEntry {
  readonly locationId: number;
  readonly speciesId: number;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly weight: number;
}

export interface Gen123Model {
  readonly typeRows: readonly CsvRow[];
  readonly typeEfficacyRows: readonly CsvRow[];
  readonly species: readonly Gen123Species[];
  readonly moves: readonly Gen123Move[];
  readonly learnsets: readonly Gen123LearnsetEntry[];
  readonly abilityRows: readonly CsvRow[];
  readonly natureRows: readonly CsvRow[];
  readonly evolutions: readonly Gen123Evolution[];
  readonly itemRows: readonly CsvRow[];
  readonly requiredItemIds: ReadonlySet<number>;
  readonly regionRows: readonly CsvRow[];
  readonly locationRows: readonly CsvRow[];
  readonly encounters: readonly Gen123EncounterEntry[];
}

const ESSENTIAL_ITEM_SLUGS = new Set([
  "poke-ball",
  "great-ball",
  "ultra-ball",
  "master-ball",
  "potion",
  "super-potion",
  "hyper-potion",
  "max-potion",
  "full-restore",
  "antidote",
  "burn-heal",
  "ice-heal",
  "awakening",
  "paralyze-heal",
  "full-heal",
  "revive",
  "max-revive",
  "ether",
  "max-ether",
  "elixir",
  "max-elixir",
  "escape-rope",
]);

function byInt(rows: readonly CsvRow[], field = "id"): Map<number, CsvRow> {
  return new Map(rows.map((row) => [requiredInt(row, field), row] as const));
}

function groupByInt(rows: readonly CsvRow[], field: string): Map<number, CsvRow[]> {
  const result = new Map<number, CsvRow[]>();
  for (const row of rows) {
    const key = requiredInt(row, field);
    const values = result.get(key) ?? [];
    values.push(row);
    result.set(key, values);
  }
  return result;
}

function statTuple(
  rows: readonly CsvRow[],
): readonly [number, number, number, number, number, number] {
  const map = new Map(
    rows.map((row) => [requiredInt(row, "stat_id"), requiredInt(row, "base_stat")]),
  );
  const values = [1, 2, 3, 4, 5, 6].map((id) => map.get(id));
  if (values.some((value) => value === undefined))
    throw new Error("Pokemon is missing one of six base stats");
  return values as [number, number, number, number, number, number];
}

function evolutionConfig(row: CsvRow): Readonly<Record<string, string | number | boolean | null>> {
  const fields = [
    "gender_id",
    "location_id",
    "held_item_id",
    "time_of_day",
    "known_move_id",
    "known_move_type_id",
    "minimum_happiness",
    "minimum_beauty",
    "minimum_affection",
    "relative_physical_stats",
    "party_species_id",
    "party_type_id",
    "trade_species_id",
    "needs_overworld_rain",
    "turn_upside_down",
    "needs_multiplayer",
    "near_special_rock",
    "region_id",
    "used_move_id",
    "minimum_move_count",
    "minimum_steps",
    "minimum_damage_taken",
  ] as const;
  const result: Record<string, string | number | boolean | null> = {};
  for (const field of fields) {
    const raw = row[field] ?? "";
    if (raw === "") continue;
    if (["needs_overworld_rain", "turn_upside_down", "needs_multiplayer"].includes(field)) {
      result[field] = raw === "1";
    } else if (/^-?\d+$/.test(raw)) {
      result[field] = Number(raw);
    } else {
      result[field] = raw;
    }
  }
  return result;
}

export async function loadGen123Model(source: Gen123Source): Promise<Gen123Model> {
  const [
    pokemonSpeciesRows,
    pokemonRows,
    pokemonStatRows,
    pokemonTypeRows,
    pokemonFormRows,
    typeRowsAll,
    typeEfficacyRows,
    moveRowsAll,
    pokemonMoveRows,
    abilityRowsAll,
    pokemonAbilityRows,
    natureRows,
    evolutionRows,
    itemRows,
    regionRowsAll,
    locationRowsAll,
    locationAreaRows,
    encounterRows,
    encounterSlotRows,
  ] = await Promise.all([
    source.csv("pokemon_species.csv"),
    source.csv("pokemon.csv"),
    source.csv("pokemon_stats.csv"),
    source.csv("pokemon_types.csv"),
    source.csv("pokemon_forms.csv"),
    source.csv("types.csv"),
    source.csv("type_efficacy.csv"),
    source.csv("moves.csv"),
    source.csv("pokemon_moves.csv"),
    source.csv("abilities.csv"),
    source.csv("pokemon_abilities.csv"),
    source.csv("natures.csv"),
    source.csv("pokemon_evolution.csv"),
    source.csv("items.csv"),
    source.csv("regions.csv"),
    source.csv("locations.csv"),
    source.csv("location_areas.csv"),
    source.csv("encounters.csv"),
    source.csv("encounter_slots.csv"),
  ]);

  const pokemonBySpecies = new Map(
    pokemonRows
      .filter(
        (row) =>
          requiredInt(row, "species_id") <= GEN123_SOURCE.speciesMaxNationalDex &&
          requiredInt(row, "is_default") === 1,
      )
      .map((row) => [requiredInt(row, "species_id"), row] as const),
  );
  const pokemonStatsByPokemon = groupByInt(pokemonStatRows, "pokemon_id");
  const pokemonTypesByPokemon = groupByInt(pokemonTypeRows, "pokemon_id");
  const pokemonAbilitiesByPokemon = groupByInt(pokemonAbilityRows, "pokemon_id");
  const abilityRows = abilityRowsAll.filter(
    (row) =>
      requiredInt(row, "generation_id") <= GEN123_SOURCE.maxGeneration &&
      requiredInt(row, "is_main_series") === 1,
  );
  const allowedAbilityIds = new Set(abilityRows.map((row) => requiredInt(row, "id")));
  const typeRows = typeRowsAll.filter(
    (row) =>
      requiredInt(row, "id") <= 17 &&
      optionalInt(row, "generation_id") !== null &&
      (optionalInt(row, "generation_id") ?? 99) <= GEN123_SOURCE.maxGeneration,
  );
  const allowedTypeIds = new Set(typeRows.map((row) => requiredInt(row, "id")));

  const species = pokemonSpeciesRows
    .filter((row) => requiredInt(row, "id") <= GEN123_SOURCE.speciesMaxNationalDex)
    .map((row): Gen123Species => {
      const speciesId = requiredInt(row, "id");
      const pokemon = pokemonBySpecies.get(speciesId);
      if (pokemon === undefined) throw new Error(`Species ${speciesId} has no default Pokemon row`);
      const pokemonId = requiredInt(pokemon, "id");
      const form = pokemonFormRows.find(
        (candidate) =>
          requiredInt(candidate, "pokemon_id") === pokemonId &&
          requiredInt(candidate, "is_default") === 1,
      );
      if (form === undefined) throw new Error(`Species ${speciesId} has no default form`);
      const typeIds = (pokemonTypesByPokemon.get(pokemonId) ?? [])
        .sort((a, b) => requiredInt(a, "slot") - requiredInt(b, "slot"))
        .map((candidate) => requiredInt(candidate, "type_id"))
        .filter((typeId) => allowedTypeIds.has(typeId));
      if (typeIds.length < 1 || typeIds.length > 2)
        throw new Error(`Species ${speciesId} has invalid Gen I-III type set`);
      const abilitySlots = (pokemonAbilitiesByPokemon.get(pokemonId) ?? [])
        .filter((candidate) => allowedAbilityIds.has(requiredInt(candidate, "ability_id")))
        .map((candidate) => ({
          abilityId: requiredInt(candidate, "ability_id"),
          slot: requiredInt(candidate, "slot"),
          hidden: requiredInt(candidate, "is_hidden") === 1,
        }));
      return {
        sourceSpeciesId: speciesId,
        sourcePokemonId: pokemonId,
        slug: requiredText(row, "identifier"),
        generationId: requiredInt(row, "generation_id"),
        captureRate: requiredInt(row, "capture_rate"),
        genderRate: optionalInt(row, "gender_rate"),
        baseExperience: requiredInt(pokemon, "base_experience"),
        height: requiredInt(pokemon, "height"),
        weight: requiredInt(pokemon, "weight"),
        stats: statTuple(pokemonStatsByPokemon.get(pokemonId) ?? []),
        typeIds,
        abilitySlots,
      };
    });

  if (species.length !== 386) throw new Error(`Expected 386 species, got ${species.length}`);

  const moves = moveRowsAll
    .filter((row) => requiredInt(row, "generation_id") <= GEN123_SOURCE.maxGeneration)
    .map(
      (row): Gen123Move => ({
        sourceId: requiredInt(row, "id"),
        slug: requiredText(row, "identifier"),
        typeId: requiredInt(row, "type_id"),
        damageClassId: requiredInt(row, "damage_class_id"),
        power: optionalInt(row, "power"),
        accuracy: optionalInt(row, "accuracy"),
        priority: requiredInt(row, "priority"),
        pp: requiredInt(row, "pp"),
        effectId: requiredInt(row, "effect_id"),
        effectChance: optionalInt(row, "effect_chance"),
      }),
    )
    .filter((move) => allowedTypeIds.has(move.typeId));
  const allowedMoveIds = new Set(moves.map((move) => move.sourceId));
  const pokemonIdToSpeciesId = new Map(
    species.map((entry) => [entry.sourcePokemonId, entry.sourceSpeciesId] as const),
  );

  const learnsetGroups = new Map<
    string,
    { speciesId: number; moveId: number; methodId: number; level: number; versions: Set<number> }
  >();
  for (const row of pokemonMoveRows) {
    const speciesId = pokemonIdToSpeciesId.get(requiredInt(row, "pokemon_id"));
    const moveId = requiredInt(row, "move_id");
    const versionGroupId = requiredInt(row, "version_group_id");
    if (
      speciesId === undefined ||
      !allowedMoveIds.has(moveId) ||
      versionGroupId > GEN123_SOURCE.maxVersionGroupId
    )
      continue;
    const methodId = requiredInt(row, "pokemon_move_method_id");
    const level = requiredInt(row, "level");
    const key = `${speciesId}:${moveId}:${methodId}:${level}`;
    const current = learnsetGroups.get(key) ?? {
      speciesId,
      moveId,
      methodId,
      level,
      versions: new Set<number>(),
    };
    current.versions.add(versionGroupId);
    learnsetGroups.set(key, current);
  }
  const learnsets = [...learnsetGroups.values()].map(
    (entry): Gen123LearnsetEntry => ({
      speciesId: entry.speciesId,
      moveId: entry.moveId,
      methodId: entry.methodId,
      level: entry.level,
      versionGroupIds: [...entry.versions].sort((a, b) => a - b),
    }),
  );

  const speciesRowsById = byInt(pokemonSpeciesRows);
  const evolutions: Gen123Evolution[] = [];
  for (const row of evolutionRows) {
    const toSpeciesId = requiredInt(row, "evolved_species_id");
    const versionGroupId = optionalInt(row, "version_group_id");
    if (
      toSpeciesId > 386 ||
      (versionGroupId !== null && versionGroupId > GEN123_SOURCE.maxVersionGroupId)
    )
      continue;
    const toSpecies = speciesRowsById.get(toSpeciesId);
    if (toSpecies === undefined) continue;
    const fromSpeciesId = optionalInt(toSpecies, "evolves_from_species_id");
    if (fromSpeciesId === null || fromSpeciesId > 386) continue;
    evolutions.push({
      fromSpeciesId,
      toSpeciesId,
      triggerId: requiredInt(row, "evolution_trigger_id"),
      itemId: optionalInt(row, "trigger_item_id") ?? optionalInt(row, "held_item_id"),
      minimumLevel: optionalInt(row, "minimum_level"),
      config: evolutionConfig(row),
    });
  }

  const requiredItemIds = new Set<number>();
  for (const row of itemRows) {
    if (ESSENTIAL_ITEM_SLUGS.has(requiredText(row, "identifier")))
      requiredItemIds.add(requiredInt(row, "id"));
  }
  for (const evolution of evolutions)
    if (evolution.itemId !== null) requiredItemIds.add(evolution.itemId);

  const regionRows = regionRowsAll.filter((row) => requiredInt(row, "id") <= 3);
  const locationRows = locationRowsAll.filter((row) => {
    const regionId = optionalInt(row, "region_id");
    return regionId !== null && regionId <= 3;
  });
  const allowedLocationIds = new Set(locationRows.map((row) => requiredInt(row, "id")));
  const locationAreaToLocation = new Map(
    locationAreaRows
      .filter((row) => allowedLocationIds.has(requiredInt(row, "location_id")))
      .map((row) => [requiredInt(row, "id"), requiredInt(row, "location_id")] as const),
  );
  const slotRarity = new Map(
    encounterSlotRows.map((row) => [requiredInt(row, "id"), requiredInt(row, "rarity")] as const),
  );
  const encounterGroups = new Map<string, Gen123EncounterEntry>();
  for (const row of encounterRows) {
    const versionId = requiredInt(row, "version_id");
    const locationId = locationAreaToLocation.get(requiredInt(row, "location_area_id"));
    const speciesId = pokemonIdToSpeciesId.get(requiredInt(row, "pokemon_id"));
    if (
      versionId > GEN123_SOURCE.maxVersionId ||
      locationId === undefined ||
      speciesId === undefined
    )
      continue;
    const minLevel = requiredInt(row, "min_level");
    const maxLevel = requiredInt(row, "max_level");
    const weight = slotRarity.get(requiredInt(row, "encounter_slot_id")) ?? 0;
    if (weight <= 0) continue;
    const key = `${locationId}:${speciesId}:${minLevel}:${maxLevel}`;
    const current = encounterGroups.get(key);
    encounterGroups.set(key, {
      locationId,
      speciesId,
      minLevel,
      maxLevel,
      weight: (current?.weight ?? 0) + weight,
    });
  }

  return {
    typeRows,
    typeEfficacyRows,
    species,
    moves,
    learnsets,
    abilityRows,
    natureRows,
    evolutions,
    itemRows,
    requiredItemIds,
    regionRows,
    locationRows,
    encounters: [...encounterGroups.values()],
  };
}
