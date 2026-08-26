import type {
  ActivateEvolutionConditionInput,
  EvolutionConditionState,
  RevokeEvolutionConditionInput,
} from "./evolution-condition-contracts.js";

export type EvolutionConditionPersistenceResult =
  | { readonly kind: "APPLIED"; readonly state: EvolutionConditionState }
  | { readonly kind: "REPLAYED"; readonly state: EvolutionConditionState }
  | { readonly kind: "POKEMON_NOT_FOUND" }
  | { readonly kind: "SOURCE_CONFLICT" }
  | { readonly kind: "STALE_REVISION"; readonly currentRevision: number };

export interface EvolutionConditionRepository {
  activate(input: ActivateEvolutionConditionInput): Promise<EvolutionConditionPersistenceResult>;
  revoke(input: RevokeEvolutionConditionInput): Promise<EvolutionConditionPersistenceResult>;
}
