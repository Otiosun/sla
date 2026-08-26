export interface PokemonBaseStats {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly spAttack: number;
  readonly spDefense: number;
  readonly speed: number;
}

export interface PokemonIvs {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly spAttack: number;
  readonly spDefense: number;
  readonly speed: number;
}

export interface PokemonNatureEffect {
  readonly increasedStat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  readonly decreasedStat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
}

export interface PokemonDerivedStats extends PokemonBaseStats {}

const BP = 10_000;

function natureBasisPoints(
  stat: NonNullable<PokemonNatureEffect["increasedStat"]>,
  nature: PokemonNatureEffect,
  enabled: boolean,
): number {
  if (!enabled) return BP;
  if (nature.increasedStat === stat) return 11_000;
  if (nature.decreasedStat === stat) return 9_000;
  return BP;
}

function nonHpStat(base: number, iv: number, level: number, natureBp: number): number {
  const beforeNature = Math.floor(((2 * base + iv) * level) / 100) + 5;
  return Math.max(1, Math.floor((beforeNature * natureBp) / BP));
}

export function calculatePokemonStats(input: {
  readonly baseStats: PokemonBaseStats;
  readonly ivs: PokemonIvs;
  readonly level: number;
  readonly nature: PokemonNatureEffect;
  readonly ivEnabled: boolean;
  readonly natureEnabled: boolean;
}): PokemonDerivedStats {
  const ivs = input.ivEnabled
    ? input.ivs
    : { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
  const level = input.level;
  return {
    hp: Math.floor(((2 * input.baseStats.hp + ivs.hp) * level) / 100) + level + 10,
    attack: nonHpStat(
      input.baseStats.attack,
      ivs.attack,
      level,
      natureBasisPoints("ATTACK", input.nature, input.natureEnabled),
    ),
    defense: nonHpStat(
      input.baseStats.defense,
      ivs.defense,
      level,
      natureBasisPoints("DEFENSE", input.nature, input.natureEnabled),
    ),
    spAttack: nonHpStat(
      input.baseStats.spAttack,
      ivs.spAttack,
      level,
      natureBasisPoints("SP_ATTACK", input.nature, input.natureEnabled),
    ),
    spDefense: nonHpStat(
      input.baseStats.spDefense,
      ivs.spDefense,
      level,
      natureBasisPoints("SP_DEFENSE", input.nature, input.natureEnabled),
    ),
    speed: nonHpStat(
      input.baseStats.speed,
      ivs.speed,
      level,
      natureBasisPoints("SPEED", input.nature, input.natureEnabled),
    ),
  };
}

export function adjustCurrentHpAfterStatChange(input: {
  readonly currentHp: number;
  readonly oldMaxHp: number;
  readonly newMaxHp: number;
}): number {
  if (input.currentHp <= 0) return 0;
  const gainedMaxHp = input.newMaxHp - input.oldMaxHp;
  return Math.max(1, Math.min(input.newMaxHp, input.currentHp + gainedMaxHp));
}
