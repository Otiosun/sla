import type { CorrectPokemonProgressionInput, CreatePokemonInput } from "./admin-contracts.js";
import type { PokemonAdminPersistenceResult } from "./admin-ports.js";

export interface PokemonLifecycleAdminRepository {
  createPokemon(input: CreatePokemonInput): Promise<PokemonAdminPersistenceResult>;
  correctProgression(input: CorrectPokemonProgressionInput): Promise<PokemonAdminPersistenceResult>;
}
