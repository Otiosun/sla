import type { AdminOperationRecord, AdminSimulationResult } from "./contracts.js";
import type {
  AdminBatchCurrentTargetState,
  AdminBatchExecuteInput,
  AdminBatchPreviewRequest,
  AdminBatchTargetView,
  AdminBatchView,
} from "./batch-contracts.js";

export type AdminBatchPreviewPersistenceResult =
  | { readonly kind: "CREATED" | "REPLAYED"; readonly batch: AdminBatchView }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "INVALID_RESOURCE"; readonly reason: string }
  | { readonly kind: "LIMIT_EXCEEDED"; readonly limit: number };

export type AdminBatchActivationResult =
  | { readonly kind: "ACTIVATED" | "REPLAYED"; readonly before: AdminBatchView; readonly after: AdminBatchView }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "INVALID_STATE"; readonly status: string }
  | { readonly kind: "REVISION_CONFLICT"; readonly actualRevision: bigint }
  | { readonly kind: "AUTHORIZATION_CONFLICT" };

export interface AdminBatchRepository {
  createOrReplayPreview(
    input: AdminBatchPreviewRequest & { readonly requestFingerprint: string },
  ): Promise<AdminBatchPreviewPersistenceResult>;
  getBatch(batchId: string): Promise<AdminBatchView | null>;
  activateExecution(input: {
    readonly batchId: string;
    readonly expectedRevision: bigint;
    readonly authorizationOperationId: string;
  }): Promise<AdminBatchActivationResult>;
  withExecutionLock<T>(batchId: string, work: () => Promise<T>): Promise<T>;
  loadNextTargets(batchId: string, limit: number): Promise<readonly AdminBatchTargetView[]>;
  currentTargetState(target: AdminBatchTargetView, batch: AdminBatchView): Promise<AdminBatchCurrentTargetState>;
  skipTarget(
    targetId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
  claimTarget(targetId: string): Promise<void>;
  applyTargetResult(targetId: string, result: Readonly<Record<string, unknown>>): Promise<void>;
  failTarget(targetId: string, errorCode: string, errorMessage: string): Promise<void>;
  refreshProgress(batchId: string): Promise<AdminBatchView>;
}

export interface AdminBatchOperationPort {
  simulateBatchExecution(
    input: AdminBatchExecuteInput,
    expectedRiskTier: 3 | 4,
  ): Promise<AdminSimulationResult>;
  applyBatchExecution(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminBatchExecuteInput,
    expectedRiskTier: 3 | 4,
  ): Promise<AdminOperationRecord>;
}
