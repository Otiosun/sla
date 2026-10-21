// Competitive group spawns are not canonical overworld encounters.
// Reserve legendary/mythical Pokemon for explicit narrative or event routes.
export const COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX: readonly number[] = Object.freeze([
  144, 145, 146, 150, 151,
  243, 244, 245, 249, 250, 251,
  377, 378, 379, 380, 381, 382, 383, 384, 385, 386,
]);

// One weight per species, not one per encounter table: common route species
// must not overwhelm the competitive lottery merely by appearing in many areas.
export function competitiveSpawnGlobalWeight(catchRate: number | null): number {
  if (catchRate === null || !Number.isFinite(catchRate)) return 12;
  if (catchRate >= 190) return 100;
  if (catchRate >= 120) return 65;
  if (catchRate >= 45) return 30;
  if (catchRate >= 15) return 12;
  return 4;
}
