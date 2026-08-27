import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminOperationRecord } from "./contracts.js";
import type { AdminOperationRegistry } from "./operation-registry.js";
import type { AdminOperationCompletionPort, AdminOperationRepository } from "./ports.js";
import type { AdminService } from "./service.js";
import {
  AdminBatchExecuteInputSchema,
  AdminBatchPreviewInputSchema,
  batchActionOperation,
  type AdminBatchAction,
  type AdminBatchExecutionResult,
  type AdminBatchPreviewInput,
  type AdminBatchPreviewResult,
  type AdminBatchRecord,
  type AdminBatchSelector,
  type AdminBatchTargetResult,
} from "./batch-contracts.js";

export interface AdminBatchRepository {
  createOrReplayPreview(input: {
    readonly batchId: string;
    readonly principalId: string;
    readonly previewAdminOperationId: string;
    readonly selector: AdminBatchSelector;
    readonly action: AdminBatchAction;
    readonly childOperationType: string;
    readonly childCapabilityKey: string;
    readonly chunkSize: number;
    readonly reason: string;
    readonly correlationId: string;
  }): Promise<{ readonly batch: AdminBatchRecord; readonly replayed: boolean }>;
  getBatch(batchId: string): Promise<AdminBatchRecord | null>;
  claimExecution(input: {
    readonly batchId: string;
    readonly principalId: string;
    readonly executeAdminOperationId: string;
    readonly expectedRevision: bigint;
  }): Promise<{ readonly batch: AdminBatchRecord; readonly replayedTerminal: boolean }>;
  loadPendingTargets(batchId: string, limit: number): Promise<readonly AdminBatchTargetResult[]>;
  recordAttempt(batchId: string, ordinal: number): Promise<void>;
  recordSuccess(input: {
    readonly batchId: string;
    readonly ordinal: number;
    readonly childAdminOperationId: string;
    readonly result: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  recordFailure(input: {
    readonly batchId: string;
    readonly ordinal: number;
    readonly errorCode: string;
  }): Promise<void>;
  refreshProgress(batchId: string): Promise<AdminBatchRecord>;
  listFailures(batchId: string): Promise<readonly AdminBatchTargetResult[]>;
}

function requiredReason(operation: AdminOperationRecord): string {
  const reason = operation.reason?.trim();
  if (reason === undefined || reason.length === 0) {
    throw new AdminError(
      ADMIN_ERROR_CODES.REASON_REQUIRED,
      "Admin batch operation requires reason",
    );
  }
  return reason;
}

function requiredExpectedRevision(operation: AdminOperationRecord): bigint {
  if (operation.expectedRevision === null) {
    throw new AdminError(
      ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
      "Admin batch execution requires expectedRevision",
    );
  }
  return operation.expectedRevision;
}

function isTargetFailure(error: AdminError): boolean {
  return (
    error.code === ADMIN_ERROR_CODES.TARGET_NOT_FOUND ||
    error.code === ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED ||
    error.code === ADMIN_ERROR_CODES.INVALID_INPUT
  );
}

export class AdminBatchService {
  public constructor(
    private readonly admin: AdminService,
    private readonly registry: AdminOperationRegistry,
    private readonly authRepository: Pick<AdminOperationRepository, "getAuthorizationSnapshot">,
    private readonly repository: AdminBatchRepository,
    private readonly completion: AdminOperationCompletionPort,
  ) {}

  private async requireLowRiskChildCapability(
    principalId: string,
    action: AdminBatchAction,
  ): Promise<{ readonly operationType: string; readonly capabilityKey: string }> {
    const mapped = batchActionOperation(action);
    const definition = this.registry.require(mapped.operationType);
    if (
      definition.kind !== "MUTATION" ||
      definition.riskTier > 2 ||
      definition.authorizationMode !== "SUBJECT" ||
      definition.capabilityKey !== mapped.capabilityKey ||
      definition.policy.requiresExpectedRevision ||
      definition.policy.requiresSimulation ||
      definition.policy.requiresConfirmation ||
      definition.policy.requiredApprovals !== 0
    ) {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
        "Child operation is not eligible for low-risk server-side batch execution",
        { operationType: mapped.operationType },
      );
    }
    const snapshot = await this.authRepository.getAuthorizationSnapshot(principalId);
    if (snapshot === null) {
      throw new AdminError(ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND, "Admin principal not found");
    }
    if (snapshot.status !== "ACTIVE") {
      throw new AdminError(ADMIN_ERROR_CODES.PRINCIPAL_DISABLED, "Admin principal is disabled");
    }
    const capability = snapshot.capabilities.find((grant) => grant.key === mapped.capabilityKey);
    if (capability === undefined) {
      throw new AdminError(
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Batch child capability denied",
        {
          capabilityKey: mapped.capabilityKey,
        },
      );
    }
    if (capability.riskTier !== definition.riskTier) {
      throw new AdminError(
        ADMIN_ERROR_CODES.CAPABILITY_POLICY_DRIFT,
        "Batch child capability risk tier differs from Registry policy",
        { capabilityKey: mapped.capabilityKey },
      );
    }
    return mapped;
  }

  public async preview(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    rawInput: AdminBatchPreviewInput,
  ): Promise<AdminOperationRecord> {
    const input = AdminBatchPreviewInputSchema.parse(rawInput);
    if (operation.targetType !== "ADMIN_BATCH_COLLECTION" || operation.targetId !== null) {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
        "Batch preview operation target no longer matches Registry policy",
      );
    }
    const mapped = await this.requireLowRiskChildCapability(operation.principalId, input.action);
    const created = await this.repository.createOrReplayPreview({
      batchId: operation.id,
      principalId: operation.principalId,
      previewAdminOperationId: operation.id,
      selector: input.selector,
      action: input.action,
      childOperationType: mapped.operationType,
      childCapabilityKey: mapped.capabilityKey,
      chunkSize: input.chunkSize,
      reason: requiredReason(operation),
      correlationId: operation.correlationId,
    });
    const value = this.previewResult(created.batch, input.chunkSize);
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "ADMIN_BATCH",
      resourceId: created.batch.id,
      beforeData: { absent: true },
      afterData: value,
      result: { ...value, ownerReplayed: created.replayed },
    });
  }

  private previewResult(batch: AdminBatchRecord, chunkSize: number): AdminBatchPreviewResult {
    const sample = batch.report.sampleTargetIds;
    return {
      batchId: batch.id,
      childOperationType: batch.childOperationType,
      targetCount: batch.targetCount,
      estimatedChunks: Math.ceil(batch.targetCount / chunkSize),
      chunkSize,
      revision: batch.revision.toString(),
      sampleTargetIds: Array.isArray(sample)
        ? sample.filter((value): value is string => typeof value === "string").slice(0, 10)
        : [],
    };
  }

  public async execute(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    rawInput: { readonly batchId: string },
  ): Promise<AdminOperationRecord> {
    const input = AdminBatchExecuteInputSchema.parse(rawInput);
    if (operation.targetType !== "ADMIN_BATCH" || operation.targetId !== input.batchId) {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
        "Batch execute operation target no longer matches Registry policy",
      );
    }
    const existing = await this.repository.getBatch(input.batchId);
    if (existing === null) {
      throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin batch was not found");
    }
    if (existing.principalId !== operation.principalId) {
      throw new AdminError(
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Only the principal that previewed a batch may execute it",
      );
    }
    const action = AdminBatchPreviewInputSchema.shape.action.parse(existing.sharedInput.action);
    await this.requireLowRiskChildCapability(operation.principalId, action);
    const claimed = await this.repository.claimExecution({
      batchId: input.batchId,
      principalId: operation.principalId,
      executeAdminOperationId: operation.id,
      expectedRevision: requiredExpectedRevision(operation),
    });
    if (!claimed.replayedTerminal) {
      await this.runPendingTargets(claimed.batch);
    }
    const finalBatch = await this.repository.refreshProgress(input.batchId);
    if (finalBatch.status !== "COMPLETED" && finalBatch.status !== "COMPLETED_WITH_ERRORS") {
      throw new AdminError(
        ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
        "Admin batch still has pending targets after server-side execution",
        { batchId: input.batchId, checkpointOrdinal: finalBatch.checkpointOrdinal },
      );
    }
    const failures = await this.repository.listFailures(input.batchId);
    const value: AdminBatchExecutionResult = {
      batchId: finalBatch.id,
      status: finalBatch.status,
      targetCount: finalBatch.targetCount,
      successCount: finalBatch.successCount,
      failureCount: finalBatch.failureCount,
      checkpointOrdinal: finalBatch.checkpointOrdinal,
      revision: finalBatch.revision.toString(),
      replayed: claimed.replayedTerminal,
      failures: failures.slice(0, 100).map((failure) => ({
        ordinal: failure.ordinal,
        playerId: failure.playerId,
        errorCode: failure.errorCode,
        attempts: failure.attempts,
      })),
    };
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "ADMIN_BATCH",
      resourceId: finalBatch.id,
      beforeData: {
        batchId: finalBatch.id,
        status: "PREVIEWED",
        revision: operation.expectedRevision?.toString() ?? null,
      },
      afterData: value,
      result: value,
    });
  }

  private async runPendingTargets(batch: AdminBatchRecord): Promise<void> {
    const chunkSizeValue = batch.sharedInput.chunkSize;
    const chunkSize =
      typeof chunkSizeValue === "number" && Number.isInteger(chunkSizeValue)
        ? Math.max(1, Math.min(100, chunkSizeValue))
        : 25;
    for (;;) {
      const targets = await this.repository.loadPendingTargets(batch.id, chunkSize);
      if (targets.length === 0) break;
      for (const target of targets) {
        await this.repository.recordAttempt(batch.id, target.ordinal);
        try {
          const prepared = await this.admin.prepareMutation({
            principalId: batch.principalId,
            operationType: batch.childOperationType,
            input: target.childInput,
            reason: batch.reason,
            idempotencyKey: target.childIdempotencyKey,
            correlationId: batch.correlationId,
          });
          const applied = await this.admin.apply(prepared.operation.id, batch.principalId);
          if (applied.status !== "APPLIED") {
            throw new AdminError(
              ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
              "Batch child operation did not reach APPLIED",
              { childOperationId: applied.id },
            );
          }
          await this.repository.recordSuccess({
            batchId: batch.id,
            ordinal: target.ordinal,
            childAdminOperationId: applied.id,
            result: applied.result ?? { applied: true },
          });
        } catch (error) {
          if (error instanceof AdminError && isTargetFailure(error)) {
            await this.repository.recordFailure({
              batchId: batch.id,
              ordinal: target.ordinal,
              errorCode: error.code,
            });
            continue;
          }
          throw error;
        }
      }
      await this.repository.refreshProgress(batch.id);
    }
  }
}
