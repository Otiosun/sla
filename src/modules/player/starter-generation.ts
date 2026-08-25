import type { RandomSource } from "../../platform/rng/index.js";
import type { GeneratedStarter, StarterBuild, StarterMoveCandidate } from "./contracts.js";

function chooseOne<T>(values: readonly T[], rng: RandomSource, label: string): T {
  if (values.length === 0) throw new Error(`Starter build has no ${label}`);
  const value = values[rng.randomInt(values.length)];
  if (value === undefined) throw new Error(`Failed to choose starter ${label}`);
  return value;
}

function initialHp(baseHp: number, ivHp: number, level: number): number {
  return Math.floor(((2 * baseHp + ivHp) * level) / 100) + level + 10;
}

function eligibleMoves(candidates: readonly StarterMoveCandidate[], level: number) {
  const seen = new Set<string>();
  const selected: StarterMoveCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.learnMethod === "LEVEL" && (candidate.learnLevel === null || candidate.learnLevel > level)) {
      continue;
    }
    if (seen.has(candidate.moveId)) continue;
    seen.add(candidate.moveId);
    selected.push(candidate);
    if (selected.length === 4) break;
  }
  return selected;
}

export function generateStarter(build: StarterBuild, rng: RandomSource): GeneratedStarter {
  if (!Number.isSafeInteger(build.starterLevel) || build.starterLevel < 1 || build.starterLevel > 100) {
    throw new RangeError("Starter level is outside the supported range");
  }
  if (!Number.isSafeInteger(build.baseHp) || build.baseHp <= 0) {
    throw new RangeError("Starter base HP must be a positive safe integer");
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
  const moves = eligibleMoves(build.moves, build.starterLevel).map((move) => {
    if (!Number.isSafeInteger(move.maxPp) || move.maxPp <= 0) {
      throw new RangeError("Starter move max PP must be a positive safe integer");
    }
    return { moveId: move.moveId, ppCurrent: move.maxPp };
  });
  if (moves.length === 0) throw new Error("Starter build has no eligible move");

  return {
    level: build.starterLevel,
    currentHp: initialHp(build.baseHp, ivs.hp, build.starterLevel),
    abilityId,
    natureId,
    ivs,
    moves,
  };
}
