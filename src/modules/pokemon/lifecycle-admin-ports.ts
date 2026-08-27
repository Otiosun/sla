import type {
  CorrectPokemonProgressInput,
  CreatePokemonInput,
  PokemonCreateResult,
} from "./admin-contracts.js";
import type { PokemonAdminPersistenceResult } from "./admin-ports.js";

export type PokemonCreatePersistenceResult =
  | { readonly kind: "APPLIED"; readonly result: PokemonCreateResult }
  | { readonly kind: "REPLAYED"; readonly result: PokemonCreateResult }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "INVALID_STATE"; readonly reason: string }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export interface PokemonLifecycleAdminRepository {
  createPokemon(input: CreatePokemonInput): Promise<PokemonCreatePersistenceResult>;
  correctProgress(input: CorrectPokemonProgressInput): Promise<PokemonAdminPersistenceResult>;
}
