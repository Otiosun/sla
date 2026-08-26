import type {
  ApplyBattleRewardInput,
  BattleRewardResult,
  EvolvePokemonInput,
  EvolutionResult,
  MoveChoiceResult,
  ResolveMoveChoiceInput,
} from "./contracts.js";

export type BattleRewardPersistenceResult =
  | { readonly kind: "APPLIED"; readonly result: BattleRewardResult }
  | { readonly kind: "REPLAYED"; readonly result: BattleRewardResult }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "NOT_ELIGIBLE"; readonly status: string }
  | { readonly kind: "UNSUPPORTED"; readonly reason: string }
  | { readonly kind: "RULES_MISSING" }
  | { readonly kind: "STATE_INVALID"; readonly reason: string }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export type MoveChoicePersistenceResult =
  | { readonly kind: "RESOLVED"; readonly result: MoveChoiceResult }
  | { readonly kind: "REPLAYED"; readonly result: MoveChoiceResult }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "CONFLICT"; readonly reason: string };

export type EvolutionPersistenceResult =
  | { readonly kind: "EVOLVED"; readonly result: EvolutionResult }
  | { readonly kind: "REPLAYED"; readonly result: EvolutionResult }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "NOT_ELIGIBLE"; readonly reason: string }
  | { readonly kind: "ITEM_MISSING" }
  | { readonly kind: "RULES_MISSING" }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export interface ProgressionRepository {
  applyBattleReward(input: ApplyBattleRewardInput): Promise<BattleRewardPersistenceResult>;
  resolveMoveChoice(input: ResolveMoveChoiceInput): Promise<MoveChoicePersistenceResult>;
  evolvePokemon(input: EvolvePokemonInput): Promise<EvolutionPersistenceResult>;
}
