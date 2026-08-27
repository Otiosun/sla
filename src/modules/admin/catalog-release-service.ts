import type { AppError } from "../../shared-kernel/result.js";
import {
  CatalogReleaseDiffInputSchema,
  CatalogReleaseLifecycleInputSchema,
  type CatalogReleaseDiffInput,
  type CatalogReleaseLifecycleInput,
  type CatalogReleaseLifecycleMutationResult,
} from "../catalog/release-admin-contracts.js";
import type { CatalogReleaseAdminService } from "../catalog/release-admin-service.js";
import type { AdminCatalogReleaseOperationPort } from "./catalog-release-ports.js";
import type { AdminOperationRecord, AdminSimulationResult } from "./contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminOperationCompletionPort } from "./ports.js";
import type { AdminService } from "./service.js";

function ownerError(error: AppError): AdminError {
  if (error.code === "IDEMPOTENCY_KEY_INVALID") {
    return new AdminError(ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, error.message, error.details);
  }
  if (error.code === "REVISION_CONFLICT") {
    return new AdminError(ADMIN_ERROR_CODES.REVISION_CONFLICT, error.message, error.details);
  }
  if (error.code === "NOT_FOUND") {
    return new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, error.message, error.details);
  }
  if (error.code === "VALIDATION_FAILED") {
    return new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, error.message, error.details);
  }
  return new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, error.message, {
    ownerCode: error.code,
    ...(error.details ?? {}),
  });
}

function requiredReason(operation: AdminOperationRecord): string {
  if (operation.reason === null || operation.reason.trim().length === 0) {
    throw new AdminError(
      ADMIN_ERROR_CODES.REASON_REQUIRED,
      "Catalog release lifecycle mutation requires reason",
    );
  }
  return operation.reason;
}

function requiredExpectedRevision(operation: AdminOperationRecord): bigint {
  if (operation.expectedRevision === null) {
    throw new AdminError(
      ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
      "Catalog release lifecycle mutation requires expected release revision",
    );
  }
  return operation.expectedRevision;
}

function assertReleaseTarget(operation: AdminOperationRecord, releaseId: string): void {
  if (operation.targetType !== "CONTENT_RELEASE" || operation.targetId !== releaseId) {
    throw new AdminError(
      ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
      "Catalog release admin operation target no longer matches input",
    );
  }
}

export class AdminCatalogReleaseOperationService implements AdminCatalogReleaseOperationPort {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly owner: CatalogReleaseAdminService,
    private readonly completion: AdminOperationCompletionPort,
  ) {}

  public async diff(input: CatalogReleaseDiffInput & { readonly principalId: string }) {
    const parsed = CatalogReleaseDiffInputSchema.safeParse({
      fromReleaseId: input.fromReleaseId,
      toReleaseId: input.toReleaseId,
    });
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid content release diff request");
    }
    await this.authorizer.authorizeRead({
      principalId: input.principalId,
      operationType: "content.release.diff",
      input: parsed.data,
    });
    const result = await this.owner.diffReleases(parsed.data.fromReleaseId, parsed.data.toReleaseId);
    if (!result.ok) throw ownerError(result.error);
    return result.value;
  }

  public async simulateCatalogReleasePublish(
    input: CatalogReleaseLifecycleInput,
  ): Promise<AdminSimulationResult> {
    CatalogReleaseLifecycleInputSchema.parse(input);
    const result = await this.owner.previewPublishRelease(input.releaseId);
    if (!result.ok) throw ownerError(result.error);
    return {
      summary: {
        releaseId: result.value.releaseId,
        revision: result.value.revision,
        parentReleaseId: result.value.parentReleaseId,
        fingerprint: result.value.fingerprint,
        diff: result.value.diff,
      },
      before: result.value.before,
      after: result.value.after,
    };
  }

  public async applyCatalogReleaseValidate(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogReleaseLifecycleInput,
  ): Promise<AdminOperationRecord> {
    CatalogReleaseLifecycleInputSchema.parse(input);
    assertReleaseTarget(operation, input.releaseId);
    const result = await this.owner.validate({
      releaseId: input.releaseId,
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: {
        sourceType: "ADMIN_OPERATION",
        sourceId: operation.id,
        reason: requiredReason(operation),
        actorType: "ADMIN",
        actorId: operation.principalId,
      },
    });
    if (!result.ok) throw ownerError(result.error);
    return this.complete(operation, actorPrincipalId, result.value);
  }

  public async applyCatalogReleasePublish(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogReleaseLifecycleInput,
  ): Promise<AdminOperationRecord> {
    CatalogReleaseLifecycleInputSchema.parse(input);
    assertReleaseTarget(operation, input.releaseId);
    const result = await this.owner.publish({
      releaseId: input.releaseId,
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: {
        sourceType: "ADMIN_OPERATION",
        sourceId: operation.id,
        reason: requiredReason(operation),
        actorType: "ADMIN",
        actorId: operation.principalId,
      },
    });
    if (!result.ok) throw ownerError(result.error);
    return this.complete(operation, actorPrincipalId, result.value);
  }

  private async complete(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    value: CatalogReleaseLifecycleMutationResult,
  ): Promise<AdminOperationRecord> {
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "CONTENT_RELEASE",
      resourceId: value.releaseId,
      beforeData: value.beforeData,
      afterData: value.afterData,
      result: {
        operationKind: value.operationKind,
        releaseId: value.releaseId,
        revision: value.revision,
        beforeStatus: value.beforeStatus,
        afterStatus: value.afterStatus,
        fingerprint: value.fingerprint,
        ownerReplayed: value.replayed,
      },
    });
  }
}
