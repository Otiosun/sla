export type CompetitiveSpawnBaseRewardKind = "MONEY" | "ITEM" | "PROGRESSION";

export interface CompetitiveSpawnRewardDescriptor {
  readonly kind: CompetitiveSpawnBaseRewardKind;
  readonly amount: number;
  readonly currencyId: string | null;
  readonly itemId: string | null;
  readonly displayName: string;
}

function roll(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 10_000) {
    throw new RangeError("Competitive spawn reward roll must be an integer from 0 to 9999");
  }
  return value;
}

export function competitiveSpawnBaseRewardKind(value: number): CompetitiveSpawnBaseRewardKind {
  const normalized = roll(value);
  if (normalized < 4_500) return "MONEY";
  if (normalized < 8_000) return "ITEM";
  return "PROGRESSION";
}

export function competitiveSpawnMoneyAmount(value: number): number {
  return 800 + (roll(value) % 2_201);
}

export function competitiveSpawnItemQuantity(value: number): number {
  return 1 + (roll(value) % 4);
}

export function competitiveSpawnProgressAmount(value: number): number {
  return 5 + (roll(value) % 11);
}

export function competitiveSpawnPokemonBonusBasisPoints(catchRate: number | null): number {
  if (catchRate === null || !Number.isFinite(catchRate) || catchRate < 0) return 600;
  if (catchRate >= 190) return 1_800;
  if (catchRate >= 90) return 800;
  if (catchRate >= 45) return 400;
  return 150;
}

export function competitiveSpawnPokemonBonusWon(catchRate: number | null, value: number): boolean {
  return roll(value) < competitiveSpawnPokemonBonusBasisPoints(catchRate);
}
