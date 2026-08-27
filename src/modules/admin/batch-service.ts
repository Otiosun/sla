import { createHash } from "node:crypto";
import type { EconomyService } from "../economy/service.js";
import { parsePlayerId } from "../../shared-kernel/ids.js";
import {
  AdminBatchInspectRequestSchema,
  AdminBatchPreviewRequestSchema,
  type AdminBatchMutation,
  type AdminBatchProcessResult,
  type AdminBatchTargetView,
  type AdminBatchView,
  type AdminBatchExecuteInput,
} from "./batch-contracts.js";
import type { AdminBatchOperationPort, AdminBatchRepository } from "./batch-ports.js";
import type { AdminOperationRecord } from "./contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminOperationCompletionPort, AdminOperationRepository } from "./ports.js";
import type { AdminService } from "./service.js";

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    );
  }
  return value;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function requiredCapability(mutation: AdminBatchMutation): {
  readonly key: "wallet.adjust" | "inventory.adjust";
  readonly riskTier: 2;
} {
  return mutation.kind === "WALLET_ADJUST"
    ? { key: "wallet.adjust", riskTier: 2 }
    : { key: "inventory.adjust", riskTier: 2 };
}

function requireExpectedRevision(operation: AdminOperationRecord): bigint {
  if (operation.expectedRevision === null) {
    throw new AdminError(
      ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
      "Batch execution requires expected batch revision",
    );
  }
  return operation.expectedRevision;
}

function batchState(batch: AdminBatchView): Readonly<Record<string, unknown>> {
  return {
    batchId: batch.id,
    status: batch.status,
    executionRiskTier: batch.executionRiskTier,
    targetCount: batch.targetCount,
    checkpointSeq: batch.checkpointSeq,
    revision: batch.revision,
  };
}

function expectedDryRunError(target: AdminBatchTargetView): {
  readonly code: string;
  readonly message: string;
} {
  const code = target.dryRun.expectedErrorCode;
  const message = target.dryRun.expectedErrorMessage;
  return {
    code: typeof code === "string" ? code : "BATCH_DRY_RUN_REJECTED",
    message: typeof message === "string" ? message : "Target was rejected by the frozen dry-run",
  };
}

export class AdminBatchService implements AdminBatchOperationPort {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly authorizationRepository: Pick<AdminOperationRepository, "getAuthorizationSnapshot">,
    private readonly repository: AdminBatchRepository,
    private readonly economy: EconomyService,
    private readonly completion: AdminOperationCompletionPort,
  ) {}

  private async requireUnderlyingCapability(
    principalId: string,
    mutation: AdminBatchMutation,
  ): Promise<void> {
    const snapshot = await this.authorizationRepository.getAuthorizationSnapshot(principalId);
    if (snapshot === null) {
      throw new AdminError(ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND, "Admin principal not found");
    }
    if (snapshot.status !== "ACTIVE") {
      throw new AdminError(ADMIN_ERROR_CODES.PRINCIPAL_DISABLED, "Admin principal is disabled");
    }
    if (!snapshot.scopes.some((scope) => scope.scopeType === "GLOBAL" && scope.scopeId === null)) {
      throw new AdminError(
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Batch administration requires GLOBAL scope",
      );
    }
    const required = requiredCapability(mutation);
    const grant = snapshot.capabilities.find((capability) => capability.key === required.key);
    if (grant === undefined) {
      throw new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Batch target capability denied", {
        capabilityKey: required.key,
      });
    }
    if (grant.riskTier !== required.riskTier) {
      throw new AdminError(
        ADMIN_ERROR_CODES.CAPABILITY_POLICY_DRIFT,
        "Batch target capability risk tier differs from policy",
        { capabilityKey: required.key },
      );
    }
  }

  public async preview(rawRequest: unknown): Promise<{ readonly batch: AdminBatchView; readonly replayed: boolean }> {
    const parsed = AdminBatchPreviewRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid admin batch preview request", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      });
    }
    await this.authorizer.authorizeRead({
      principalId: parsed.data.principalId,
      operationType: "batch.preview",
      input: {},
    });
    await this.requireUnderlyingCapability(parsed.data.principalId, parsed.data.mutation);

    const requestFingerprint = fingerprint({
      principalId: parsed.data.principalId,
      selector: parsed.data.selector,
      mutation: parsed.data.mutation,
      reason: parsed.data.reason,
      correlationId: parsed.data.correlationId,
      chunkSize: parsed.data.chunkSize,
    });
    const persisted = await this.repository.createOrReplayPreview({
      ...parsed.data,
      requestFingerprint,
    });
    if (persisted.kind === "IDEMPOTENCY_CONFLICT") {
      throw new AdminError(
        ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "Batch preview idempotency key conflicts with another request",
      );
    }
    if (persisted.kind === "INVALID_RESOURCE") {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, persisted.reason);
    }
    if (persisted.kind === "LIMIT_EXCEEDED") {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_INPUT,
        "Batch selector exceeds the server-side target limit",
        { limit: persisted.limit },
      );
    }
    return { batch: persisted.batch, replayed: persisted.kind === "REPLAYED" };
  }

  public async inspect(rawRequest: unknown): Promise<AdminBatchView> {
    const parsed = AdminBatchInspectRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid admin batch inspect request");
    }
    await this.authorizer.authorizeRead({
      principalId: parsed.data.principalId,
      operationType: "batch.inspect",
      input: { batchId: parsed.data.batchId },
    });
    const batch = await this.repository.getBatch(parsed.data.batchId);
    if (batch === null) {
      throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin batch not found");
    }
    return batch;
  }

  private async requireBatchForExecution(
    batchId: string,
    expectedRiskTier: 3 | 4,
  ): Promise<AdminBatchView> {
    const batch = await this.repository.getBatch(batchId);
    if (batch === null) {
      throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin batch not found");
    }
    if (batch.executionRiskTier !== expectedRiskTier) {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
        "Batch execution risk tier does not match the selected operation",
        { actualRiskTier: batch.executionRiskTier, expectedRiskTier },
      );
    }
    if (batch.status !== "PREVIEWED") {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
        "Only PREVIEWED batches may enter execution authorization",
        { status: batch.status },
      );
    }
    return batch;
  }

  public async simulateBatchExecution(
    input: AdminBatchExecuteInput,
    expectedRiskTier: 3 | 4,
  ) {
    const batch = await this.requireBatchForExecution(input.batchId, expectedRiskTier);
    return {
      summary: {
        batchId: batch.id,
        targetCount: batch.targetCount,
        dryRunReady: batch.dryRunSummary.ready,
        dryRunExpectedSkipped: batch.dryRunSummary.expectedSkipped,
        chunkSize: batch.chunkSize,
        executionRiskTier: batch.executionRiskTier,
      },
      before: batchState(batch),
      after: { ...batchState(batch), status: "READY", revision: (BigInt(batch.revision) + 1n).toString() },
    };
  }

  public async applyBatchExecution(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminBatchExecuteInput,
    expectedRiskTier: 3 | 4,
  ): Promise<AdminOperationRecord> {
    if (operation.targetType !== "ADMIN_BATCH" || operation.targetId !== input.batchId) {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
        "Batch execution operation target no longer matches input",
      );
    }
    const batch = await this.repository.getBatch(input.batchId);
    if (batch === null) {
      throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin batch not found");
    }
    if (batch.principalId !== operation.principalId) {
      throw new AdminError(
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Batch execution must be proposed by the principal that created the preview",
      );
    }
    if (batch.executionRiskTier !== expectedRiskTier || operation.riskTier !== expectedRiskTier) {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
        "Batch execution policy no longer matches frozen risk tier",
      );
    }
    await this.requireUnderlyingCapability(operation.principalId, batch.mutation);

    const activated = await this.repository.activateExecution({
      batchId: input.batchId,
      expectedRevision: requireExpectedRevision(operation),
      authorizationOperationId: operation.id,
    });
    if (activated.kind === "NOT_FOUND") {
      throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin batch not found");
    }
    if (activated.kind === "INVALID_STATE") {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
        "Batch is not PREVIEWED",
        { status: activated.status },
      );
    }
    if (activated.kind === "REVISION_CONFLICT") {
      throw new AdminError(ADMIN_ERROR_CODES.REVISION_CONFLICT, "Batch revision changed", {
        actualRevision: activated.actualRevision.toString(),
      });
    }
    if (activated.kind === "AUTHORIZATION_CONFLICT") {
      throw new AdminError(
        ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "Batch is already bound to another authorization operation",
      );
    }

    const before =
      activated.kind === "REPLAYED"
        ? {
            ...batchState(activated.after),
            status: "PREVIEWED",
            revision: operation.expectedRevision?.toString() ?? activated.after.revision,
          }
        : batchState(activated.before);
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "ADMIN_BATCH",
      resourceId: input.batchId,
      beforeData: before,
      afterData: batchState(activated.after),
      result: {
        batchId: input.batchId,
        executionRiskTier: activated.after.executionRiskTier,
        targetCount: activated.after.targetCount,
        dryRunReady: activated.after.dryRunSummary.ready,
        dryRunExpectedSkipped: activated.after.dryRunSummary.expectedSkipped,
        ownerReplayed: activated.kind === "REPLAYED",
      },
    });
  }

  private async applyClaimedTarget(
    batch: AdminBatchView,
    target: AdminBatchTargetView,
  ): Promise<Readonly<Record<string, unknown>>> {
    const parsedPlayer = parsePlayerId(target.playerId);
    if (!parsedPlayer.ok) {
      throw new Error(`Frozen batch target has invalid player id: ${target.playerId}`);
    }
    const delta = BigInt(batch.mutation.delta);
    const absolute = delta < 0n ? -delta : delta;
    const metadata = {
      sourceType: "ADMIN_BATCH",
      sourceId: batch.id,
      reason: batch.reason,
      actorType: "ADMIN" as const,
      actorId: batch.principalId,
      correlationId: batch.correlationId,
    };

    if (batch.mutation.kind === "WALLET_ADJUST") {
      const result =
        delta > 0n
          ? await this.economy.creditWallet({
              playerId: parsedPlayer.value,
              currencyId: batch.mutation.currencyId,
              amount: absolute,
              idempotencyKey: target.idempotencyKey,
              metadata,
            })
          : await this.economy.debitWallet({
              playerId: parsedPlayer.value,
              currencyId: batch.mutation.currencyId,
              amount: absolute,
              idempotencyKey: target.idempotencyKey,
              metadata,
            });
      if (!result.ok) {
        throw new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, result.error.message, {
          ownerCode: result.error.code,
        });
      }
      return {
        mutationKind: batch.mutation.kind,
        playerId: target.playerId,
        currencyId: batch.mutation.currencyId,
        delta: delta.toString(),
        balanceAfter: result.value.amount.toString(),
        ledgerId: result.value.ledgerId,
        ownerReplayed: result.value.replayed,
      };
    }

    const result =
      delta > 0n
        ? await this.economy.addItem({
            playerId: parsedPlayer.value,
            itemId: batch.mutation.itemId,
            quantity: absolute,
            idempotencyKey: target.idempotencyKey,
            metadata,
          })
        : await this.economy.consumeItem({
            playerId: parsedPlayer.value,
            itemId: batch.mutation.itemId,
            quantity: absolute,
            idempotencyKey: target.idempotencyKey,
            metadata,
          });
    if (!result.ok) {
      throw new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, result.error.message, {
        ownerCode: result.error.code,
      });
    }
    return {
      mutationKind: batch.mutation.kind,
      playerId: target.playerId,
      itemId: batch.mutation.itemId,
      delta: delta.toString(),
      balanceAfter: result.value.quantity.toString(),
      ledgerId: result.value.ledgerId,
      ownerReplayed: result.value.replayed,
    };
  }

  public async processNextChunk(batchId: string): Promise<AdminBatchProcessResult> {
    return this.repository.withExecutionLock(batchId, async () => {
      let batch = await this.repository.getBatch(batchId);
      if (batch === null) {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin batch not found");
      }
      if (batch.status === "COMPLETED" || batch.status === "COMPLETED_WITH_ERRORS") {
        if (batch.report === null) throw new Error("Terminal batch is missing final report");
        return { batchId, processed: 0, report: batch.report, status: batch.status };
      }
      if (
        (batch.status !== "READY" && batch.status !== "RUNNING") ||
        batch.authorizationOperationId === null ||
        batch.authorizationOperationStatus !== "APPLIED"
      ) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Batch worker requires an APPLIED execution authorization",
          { status: batch.status, authorizationStatus: batch.authorizationOperationStatus },
        );
      }

      const targets = await this.repository.loadNextTargets(batchId, batch.chunkSize);
      let processed = 0;
      for (const target of targets) {
        if (target.status === "PENDING") {
          if (!target.dryRunOk) {
            const expected = expectedDryRunError(target);
            await this.repository.skipTarget(target.id, expected.code, expected.message);
            processed += 1;
            continue;
          }
          const current = await this.repository.currentTargetState(target, batch);
          if (
            current.playerRevision !== target.playerRevision ||
            current.resourceRevision !== target.resourceRevision
          ) {
            await this.repository.skipTarget(
              target.id,
              "REVISION_CONFLICT",
              "Target changed after the frozen batch preview",
            );
            processed += 1;
            continue;
          }
          await this.repository.claimTarget(target.id);
        }

        try {
          const result = await this.applyClaimedTarget(batch, target);
          await this.repository.applyTargetResult(target.id, result);
        } catch (error) {
          const code =
            error instanceof AdminError
              ? error.details?.ownerCode ?? error.code
              : "BATCH_TARGET_EXECUTION_FAILED";
          const message = error instanceof Error ? error.message : "Unknown batch target failure";
          await this.repository.failTarget(target.id, String(code), message);
        }
        processed += 1;
      }

      batch = await this.repository.refreshProgress(batchId);
      if (batch.report === null) {
        throw new Error("Batch progress refresh did not persist a report snapshot");
      }
      return { batchId, processed, report: batch.report, status: batch.status };
    });
  }
}
