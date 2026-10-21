import type { CompetitiveEvolutionStage } from "./ecology-policy.js";

// Casual competitive spawns reserve legendary/mythical Pokemon for events.
export const COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX: readonly number[] = Object.freeze([
  144, 145, 146, 150, 151,
  243, 244, 245, 249, 250, 251,
  377, 378, 379, 380, 381, 382, 383, 384, 385, 386,
]);

// Species chance reflects canonical catch rate AND Gen I-III evolution stage.
// The level range is distinct from overworld area encounter levels.
export function competitiveSpawnGlobalWeight(
  catchRate: number | null,
  stage: CompetitiveEvolutionStage = 1,
): number {
  let base = 12;
  if (catchRate !== null && Number.isFinite(catchRate)) {
    if (catchRate >= 190) base = 100;
    else if (catchRate >= 120) base = 65;
    else if (catchRate >= 45) base = 30;
    else if (catchRate >= 15) base = 12;
    else base = 4;
  }

  const stagePercent = stage === 3 ? 12 : stage === 2 ? 35 : 100;
  return Math.max(1, Math.round((base * stagePercent) / 100));
}

export function competitiveSpawnLevelRange(
  stage: CompetitiveEvolutionStage,
  firstLearnableLevel: number,
): { readonly minLevel: number; readonly maxLevel: number } {
  if (
    !Number.isInteger(firstLearnableLevel) ||
    firstLearnableLevel < 1 ||
    firstLearnableLevel > 100
  ) {
    throw new RangeError("Competitive spawn first move level must be from 1 to 100");
  }
  const minByStage = stage === 3 ? 36 : stage === 2 ? 20 : 5;
  const maxByStage = stage === 3 ? 55 : stage === 2 ? 38 : 23;
  const minLevel = Math.max(minByStage, firstLearnableLevel);
  return { minLevel, maxLevel: Math.max(minLevel, maxByStage) };
}
