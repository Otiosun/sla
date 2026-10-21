// Derived from PokeAPI/pokeapi pinned commit 7af36d9f3424366ffc46e90d94c8bc120df39cd0
// data/v2/csv/pokemon_species.csv (BSD-3-Clause).
// Index = National Dex. 0 = unknown habitat. Stages count Gen I-III parent links.
export type CompetitiveEvolutionStage = 1 | 2 | 3;

const HABITAT_BY_DEX: readonly number[] = [
  0, 3, 3, 3, 4, 4, 4, 9, 9, 9, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 6, 6, 3, 3,
  2, 2, 6, 6, 3, 3, 3, 3, 3, 3, 4, 4, 3, 3, 3, 3, 1, 1, 3, 3, 3, 2, 2, 2, 2,
  1, 1, 8, 8, 9, 9, 4, 4, 3, 3, 9, 9, 9, 8, 8, 8, 4, 4, 4, 2, 2, 2, 7, 7, 4,
  4, 4, 3, 3, 9, 9, 6, 6, 3, 3, 3, 7, 7, 8, 8, 7, 7, 1, 1, 1, 1, 3, 3, 9, 9,
  8, 8, 2, 2, 4, 4, 8, 8, 3, 8, 8, 6, 6, 8, 3, 3, 7, 7, 9, 9, 7, 7, 8, 3, 8,
  3, 4, 2, 3, 9, 9, 7, 8, 8, 8, 8, 8, 8, 7, 7, 7, 7, 4, 4, 5, 5, 5, 9, 9, 9,
  5, 5, 3, 3, 3, 3, 3, 3, 9, 9, 9, 3, 3, 2, 2, 2, 2, 2, 2, 1, 7, 7, 2, 4, 3,
  2, 2, 2, 2, 3, 3, 3, 3, 9, 9, 2, 9, 3, 3, 3, 2, 3, 3, 2, 9, 9, 8, 8, 2, 9,
  1, 5, 1, 3, 2, 2, 1, 4, 1, 8, 8, 7, 3, 4, 2, 2, 4, 4, 4, 4, 1, 1, 7, 7, 7,
  4, 7, 6, 6, 6, 7, 6, 6, 8, 2, 8, 8, 8, 8, 3, 4, 3, 8, 3, 3, 3, 4, 4, 4, 5,
  5, 2, 2, 2, 2, 3, 3, 3, 9, 9, 9, 3, 3, 3, 3, 2, 2, 2, 2, 2, 9, 9, 9, 2, 2,
  2, 3, 3, 7, 7, 8, 8, 8, 9, 9, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 4, 4, 9, 1,
  2, 2, 1, 1, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 3, 3, 3, 7, 7, 7, 7, 4, 4, 4,
  4, 4, 4, 6, 6, 6, 6, 6, 2, 2, 3, 3, 1, 1, 9, 9, 9, 9, 6, 6, 7, 7, 9, 9, 9,
  9, 3, 2, 8, 8, 2, 2, 2, 3, 4, 1, 1, 1, 7, 7, 7, 7, 7, 7, 7, 7, 6, 6, 6, 6,
  6, 6, 1, 1, 1, 9, 9, 7, 6, 5, 4, 5,
];

const EVOLUTION_STAGE_BY_DEX: readonly number[] = [
  0, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 1, 2, 1, 2,
  2, 3, 1, 2, 1, 2, 3, 1, 2, 3, 2, 3, 1, 2, 2, 3, 1, 2, 1, 2, 3, 1, 2, 1, 2,
  1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 1,
  2, 3, 1, 2, 1, 2, 1, 2, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 3, 1, 1, 2, 1, 2,
  1, 2, 1, 2, 1, 2, 2, 2, 1, 1, 2, 1, 2, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 1, 2,
  2, 2, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2, 1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 2, 3,
  1, 1, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 1, 2, 1, 2, 1, 2, 3, 1, 2, 1, 1, 1,
  1, 2, 1, 2, 1, 2, 3, 3, 2, 3, 1, 3, 1, 2, 3, 1, 1, 2, 1, 1, 2, 2, 2, 1, 2,
  1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 2, 1, 2, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 1, 2,
  1, 1, 1, 1, 2, 3, 1, 2, 2, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 3, 1,
  1, 1, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 1, 2, 1, 2, 3, 2, 3, 1, 2, 3, 1, 2,
  3, 1, 2, 1, 2, 1, 2, 3, 1, 2, 1, 2, 1, 2, 3, 1, 2, 2, 1, 2, 3, 1, 2, 1, 1,
  1, 2, 1, 1, 1, 2, 3, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1,
  1, 2, 1, 1, 2, 3, 1, 2, 1, 2, 1, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1,
  2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 2, 1, 2, 3, 1, 2, 2, 1, 1, 1, 2, 3, 1,
  2, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

export function competitiveSpeciesEcology(
  nationalDex: number,
): { readonly habitatId: number | null; readonly stage: CompetitiveEvolutionStage } {
  if (!Number.isInteger(nationalDex) || nationalDex < 1 || nationalDex > 386) {
    throw new RangeError("Competitive species ecology requires a Gen I-III National Dex");
  }
  const habitat = HABITAT_BY_DEX[nationalDex];
  const stage = EVOLUTION_STAGE_BY_DEX[nationalDex];
  if (habitat === undefined || stage === undefined || ![1, 2, 3].includes(stage)) {
    throw new Error("Competitive species ecology has incomplete pinned data");
  }
  return {
    habitatId: habitat === 0 ? null : habitat,
    stage: stage as CompetitiveEvolutionStage,
  };
}
