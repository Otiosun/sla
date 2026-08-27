import type { PokemonAdminPersistenceResult } from "./admin-ports.js";
import type {
  CorrectPokemonProgressInput,
  CreatePokemonInput,
} from "./admin-contracts.js";

export interface PokemonLifecycleAdminRepository {
  createPokemon(input: CreatePokemonInput): Promise<PokemonAdminPersistenceResult>;
  correctProgress(input: CorrectPokemonProgressInput): Promise<PokemonAdminPersistenceResult>;
}
