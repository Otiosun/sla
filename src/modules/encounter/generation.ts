import type { RandomSource } from "../../platform/rng/index.js";
import type {
  EncounterTableEntryRecord,
  WildBuildMove,
  WildPokemonBuild,
  WildPokemonSnapshot,
} from "./contracts.js";

function chooseOne<T>(values: readonly T[], rng: RandomSource, label: string): T {
  if (values.length === 0) throw new Error(`Wild Pokemon build has no ${label}`);
  const selected = values[rng.randomInt(values.length)];
  if (selected === undefined) throw new Error(`Failed to choose wild Pokemon ${label}`);
  return selected;
}

export function chooseWeightedEncounterEntry(
  entries: readonly EncounterTableEntryRecord[],
  rng: RandomSource,
): EncounterTableEntryRecord {
  if (entries.length === 0) throw new Error("Encounter table has no eligible entries");
  let totalWeight = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.weight) || entry.weight <= 0) {
      throw new RangeError("Encounter weight must be a positive safe integer");
    }
    totalWeight += entry.weight;
    if (!Number.isSafeInteger(totalWeight)) {
      throw new RangeError("Encounter weight total exceeds the safe integer range");
    }
  }

  const roll = rng.randomInt(totalWeight);
  let cursor = 0;
  for (const entry of entries) {
    cursor += entry.weight;
    if (roll < cursor) return entry;
  }
  throw new Error("Weighted encounter selection did not resolve an entry");
}

export function chooseEncounterLevel(
  entry: Pick<EncounterTableEntryRecord, "minLevel" | "maxLevel">,
  rng: RandomSource,
): number {
  if (
    !Number.isSafeInteger(entry.minLevel) ||
    !Number.isSafeInteger(entry.maxLevel) ||
    entry.minLevel < 1 ||
    entry.maxLevel < entry.minLevel ||
    entry.maxLevel > 100
  ) {
    throw new RangeError("Encounter level range is invalid");
  }
  return entry.minLevel + rng.randomInt(entry.maxLevel - entry.minLevel + 1);
}

function eligibleMoves(moves: readonly WildBuildMove[], level: number): readonly WildBuildMove[] {
  const seen = new Map<string, WildBuildMove>();
  for (const move of moves) {
    if (move.learnMethod === "LEVEL" && (move.learnLevel === null || move.learnLevel > level)) {
      continue;
    }
    if (move.learnMethod !== "LEVEL" && move.learnMethod !== "START") continue;
    seen.set(move.moveId, move);
  }
  return [...seen.values()].slice(-4);
}

function maxHp(baseHp: number, ivHp: number, level: number): number {
  return Math.floor(((2 * baseHp + ivHp) * level) / 100) + level + 10;
}

export function generateWildPokemon(
  build: WildPokemonBuild,
  level: number,
  rng: RandomSource,
): WildPokemonSnapshot {
  if (!Number.isSafeInteger(level) || level < 1 || level > 100) {
    throw new RangeError("Wild Pokemon level must be in the range 1..100");
  }
  const baseStats = Object.values(build.baseStats);
  if (baseStats.some((stat) => !Number.isSafeInteger(stat) || stat <= 0)) {
    throw new RangeError("Wild Pokemon base stats must be positive safe integers");
  }

  const ivs = {
    hp: rng.randomInt(32),
    attack: rng.randomInt(32),
    defense: rng.randomInt(32),
    spAttack: rng.randomInt(32),
    spDefense: rng.randomInt(32),
    speed: rng.randomInt(32),
  } as const;
  const abilityId = chooseOne(build.abilityIds, rng, "ability");
  const natureId = chooseOne(build.natureIds, rng, "nature");
  const moves = eligibleMoves(build.moves, level).map((move) => {
    if (!Number.isSafeInteger(move.maxPp) || move.maxPp <= 0) {
      throw new RangeError("Wild Pokemon move max PP must be a positive safe integer");
    }
    return { moveId: move.moveId, ppCurrent: move.maxPp };
  });
  if (moves.length === 0) throw new Error("Wild Pokemon build has no eligible moves");

  const hp = maxHp(build.baseStats.hp, ivs.hp, level);
  return {
    schemaVersion: 1,
    formId: build.formId,
    speciesId: build.speciesId,
    level,
    type1Id: build.type1Id,
    type2Id: build.type2Id,
    baseStats: build.baseStats,
    ivs,
    natureId,
    abilityId,
    moves,
    maxHp: hp,
    currentHp: hp,
    shiny: false,
    gender: null,
  };
}
