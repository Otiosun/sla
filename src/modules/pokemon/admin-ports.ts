import type {
  ArchivePokemonInput,
  CorrectPokemonHpInput,
  CorrectPokemonStatusInput,
  MovePokemonRosterInput,
  PokemonOwnerMutationResult,
} from "./admin-contracts.js";

export type PokemonAdminPersistenceResult =
  | { readonly kind: "APPLIED"; readonly result: PokemonOwnerMutationResult }
  | { readonly kind: "REPLAYED"; readonly result: PokemonOwnerMutationResult }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "REVISION_CONFLICT"; readonly actualRevision: bigint }
  | { readonly kind: "ACTIVE_BATTLE" }
  | { readonly kind: "INVALID_STATE"; readonly reason: string }
  | { readonly kind: "TARGET_OCCUPIED" }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export interface PokemonAdminRepository {
  moveRoster(input: MovePokemonRosterInput): Promise<PokemonAdminPersistenceResult>;
  correctHp(input: CorrectPokemonHpInput): Promise<PokemonAdminPersistenceResult>;
  correctStatus(input: CorrectPokemonStatusInput): Promise<PokemonAdminPersistenceResult>;
  archivePokemon(input: ArchivePokemonInput): Promise<PokemonAdminPersistenceResult>;
}
