export const POKEMON_LEVEL_CAP = 100;
export const TRAINER_LEVEL_CAP = 100;
export type TrainerLevelCurve = "QUADRATIC_100_V1" | "LINEAR_100_V1";

export interface PokemonXpProgress {
  readonly beforeLevel: number;
  readonly beforeXp: number;
  readonly afterLevel: number;
  readonly afterXp: number;
  readonly awardedXp: number;
  readonly discardedXp: number;
  readonly crossedLevels: readonly number[];
}

export function pokemonXpRequiredForNextLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level >= POKEMON_LEVEL_CAP) return 0;
  return (level + 1) ** 3 - level ** 3;
}

export function applyPokemonXp(input: {
  readonly level: number;
  readonly xp: number;
  readonly gain: number;
  readonly levelCap?: number;
}): PokemonXpProgress {
  const levelCap = input.levelCap ?? POKEMON_LEVEL_CAP;
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > levelCap) {
    throw new Error("Pokemon level is outside the configured range");
  }
  if (!Number.isSafeInteger(input.xp) || input.xp < 0)
    throw new Error("Pokemon XP must be non-negative");
  if (!Number.isSafeInteger(input.gain) || input.gain < 0)
    throw new Error("XP gain must be non-negative");

  if (input.level === levelCap) {
    return {
      beforeLevel: input.level,
      beforeXp: input.xp,
      afterLevel: input.level,
      afterXp: 0,
      awardedXp: 0,
      discardedXp: input.gain,
      crossedLevels: [],
    };
  }

  const currentThreshold = pokemonXpRequiredForNextLevel(input.level);
  if (input.xp >= currentThreshold) {
    throw new Error("Stored Pokemon XP must be below the current level threshold");
  }

  let level = input.level;
  let xp = input.xp + input.gain;
  let consumedFromGain = input.gain;
  const crossedLevels: number[] = [];

  while (level < levelCap) {
    const threshold = pokemonXpRequiredForNextLevel(level);
    if (xp < threshold) break;
    xp -= threshold;
    level += 1;
    crossedLevels.push(level);
  }

  let discardedXp = 0;
  if (level === levelCap && xp > 0) {
    discardedXp = xp;
    consumedFromGain = Math.max(0, input.gain - discardedXp);
    xp = 0;
  }

  return {
    beforeLevel: input.level,
    beforeXp: input.xp,
    afterLevel: level,
    afterXp: xp,
    awardedXp: consumedFromGain,
    discardedXp,
    crossedLevels,
  };
}

export function battlePokemonXp(baseExp: number, defeatedLevel: number): number {
  if (!Number.isInteger(baseExp) || baseExp <= 0) throw new Error("baseExp must be positive");
  if (!Number.isInteger(defeatedLevel) || defeatedLevel < 1) {
    throw new Error("defeatedLevel must be positive");
  }
  return Math.max(1, Math.floor((baseExp * defeatedLevel) / 7));
}

export function trainerPointsRequiredForLevel(
  level: number,
  curve: TrainerLevelCurve = "QUADRATIC_100_V1",
): number {
  if (!Number.isInteger(level) || level < 1 || level > TRAINER_LEVEL_CAP) {
    throw new Error("Trainer level is outside the configured range");
  }
  if (curve === "LINEAR_100_V1") return 100 * (level - 1);
  return 100 * (level - 1) ** 2;
}

export function trainerLevelForPoints(
  points: number,
  levelCap = TRAINER_LEVEL_CAP,
  curve: TrainerLevelCurve = "QUADRATIC_100_V1",
): number {
  if (!Number.isSafeInteger(points) || points < 0)
    throw new Error("Trainer points must be non-negative");
  for (let level = levelCap; level >= 1; level -= 1) {
    if (points >= trainerPointsRequiredForLevel(level, curve)) return level;
  }
  return 1;
}
