import type { RandomSource } from "../../platform/rng/index.js";

export interface PokemonGenerationMoveCandidate {
  readonly moveId: string;
  readonly maxPp: number;
  readonly learnMethod: "START" | "LEVEL";
  readonly learnLevel: number | null;
}

export interface PokemonGenerationBuild {
  readonly level: number;
  readonly baseHp: number;
  readonly abilityIds: readonly string[];
  readonly natureIds: readonly string[];
  readonly moves: readonly PokemonGenerationMoveCandidate[];
}

export interface GeneratedPokemonBuild {
  readonly level: number;
  readonly currentHp: number;
  readonly abilityId: string;
  readonly natureId: string;
  readonly ivs: {
    readonly hp: number;
    readonly attack: number;
    readonly defense: number;
    readonly spAttack: number;
    readonly spDefense: number;
    readonly speed: number;
  };
  readonly moves: readonly {
    readonly moveId: string;
    readonly ppCurrent: number;
  }[];
}

function chooseOne<T>(values: readonly T[], rng: RandomSource, label: string): T {
  if (values.length === 0) throw new Error(`Pokemon build has no ${label}`);
  const value = values[rng.randomInt(values.length)];
  if (value === undefined) throw new Error(`Failed to choose Pokemon ${label}`);
  return value;
}

function initialHp(baseHp: number, ivHp: number, level: number): number {
  return Math.floor(((2 * baseHp + ivHp) * level) / 100) + level + 10;
}

function eligibleMoves(candidates: readonly PokemonGenerationMoveCandidate[], level: number) {
  const seen = new Set<string>();
  const selected: PokemonGenerationMoveCandidate[] = [];
  for (const candidate of candidates) {
    if (
      candidate.learnMethod === "LEVEL" &&
      (candidate.learnLevel === null || candidate.learnLevel > level)
    ) {
      continue;
    }
    if (seen.has(candidate.moveId)) continue;
    seen.add(candidate.moveId);
    selected.push(candidate);
    if (selected.length === 4) break;
  }
  return selected;
}

export function generatePokemonBuild(
  build: PokemonGenerationBuild,
  rng: RandomSource,
): GeneratedPokemonBuild {
  if (!Number.isSafeInteger(build.level) || build.level < 1 || build.level > 100) {
    throw new RangeError("Pokemon level is outside the supported range");
  }
  if (!Number.isSafeInteger(build.baseHp) || build.baseHp <= 0) {
    throw new RangeError("Pokemon base HP must be a positive safe integer");
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
  const moves = eligibleMoves(build.moves, build.level).map((move) => {
    if (!Number.isSafeInteger(move.maxPp) || move.maxPp <= 0) {
      throw new RangeError("Pokemon move max PP must be a positive safe integer");
    }
    return { moveId: move.moveId, ppCurrent: move.maxPp };
  });
  if (moves.length === 0) throw new Error("Pokemon build has no eligible move");

  return {
    level: build.level,
    currentHp: initialHp(build.baseHp, ivs.hp, build.level),
    abilityId,
    natureId,
    ivs,
    moves,
  };
}
