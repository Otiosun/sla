import type { RandomSource } from "../../platform/rng/index.js";
import { generatePokemonBuild } from "../pokemon/generation.js";
import type { GeneratedStarter, StarterBuild } from "./contracts.js";

export function generateStarter(build: StarterBuild, rng: RandomSource): GeneratedStarter {
  return generatePokemonBuild(
    {
      level: build.starterLevel,
      baseHp: build.baseHp,
      abilityIds: build.abilityIds,
      natureIds: build.natureIds,
      moves: build.moves,
    },
    rng,
  );
}
