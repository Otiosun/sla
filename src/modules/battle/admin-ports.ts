import type {
  BattleAdminCorrectStateInput,
  BattleAdminInspection,
  BattleAdminMutationResult,
  BattleAdminStateView,
} from "./admin-contracts.js";

export type BattleAdminReplayResult =
  | { readonly kind: "NONE" }
  | { readonly kind: "CONFLICT" }
  | { readonly kind: "REPLAYED"; readonly result: BattleAdminMutationResult };

export type BattleAdminCorrectionPersistenceResult =
  | { readonly kind: "PERSISTED"; readonly result: BattleAdminMutationResult }
  | { readonly kind: "REPLAYED"; readonly result: BattleAdminMutationResult }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "NOT_ACTIVE"; readonly current: BattleAdminStateView }
  | { readonly kind: "VERSION_CONFLICT"; readonly current: BattleAdminStateView }
  | { readonly kind: "INVALID_CORRECTION"; readonly reason: string };

export interface BattleAdminRepository {
  inspect(playerId: string, battleId: string): Promise<BattleAdminInspection | null>;
  replayMutation(
    battleId: string,
    causationId: string,
    operationKind: "FORCE_CANCEL" | "CORRECT_STATE",
    requestFingerprint: string,
  ): Promise<BattleAdminReplayResult>;
  correctState(
    input: BattleAdminCorrectStateInput & { readonly requestFingerprint: string },
  ): Promise<BattleAdminCorrectionPersistenceResult>;
}
