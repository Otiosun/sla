import { z } from "zod";
import type { AppError } from "../../shared-kernel/result.js";
import type { CatalogDraftService } from "../catalog/draft-service.js";
import {
  CatalogDraftCreateInputSchema,
  CatalogDraftDeactivateInputSchema,
  CatalogDraftInspectInputSchema,
  CatalogDraftReplaceInputSchema,
  type CatalogDraftCreateInput,
  type CatalogDraftDeactivateInput,
  type CatalogDraftReplaceInput,
} from "../catalog/draft-contracts.js";
import type { AdminOperationRecord } from "./contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminCatalogDraftOperationPort } from "./catalog-draft-ports.js";
import type { AdminOperationCompletionPort } from "./ports.js";
import type { AdminService } from "./service.js";

const CatalogDraftInspectRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    releaseId: z.string().uuid(),
    resourceKind: CatalogDraftInspectInputSchema.shape.resourceKind,
    resourceId: z.string().uuid(),
  })
  .strict();

function ownerError(error: AppError): AdminError {
  if (error.code === "FINGERPRINT_MISMATCH") {
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
    throw new AdminError(ADMIN_ERROR_CODES.REASON_REQUIRED, "Catalog draft mutation requires reason");
  }
  return operation.reason;
}

function requiredExpectedRevision(operation: AdminOperationRecord): bigint {
  if (operation.expectedRevision === null) {
    throw new AdminError(
      ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
      "Catalog draft mutation requires expected release revision",
    );
  }
  return operation.expectedRevision;
}

function assertReleaseTarget(operation: AdminOperationRecord, releaseId: string): void {
  if (operation.targetType !== "CONTENT_RELEASE" || operation.targetId !== releaseId) {
    throw new AdminError(
      ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
      "Catalog admin operation target no longer matches release input",
    );
  }
}

export class AdminCatalogDraftOperationService implements AdminCatalogDraftOperationPort {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly owner: CatalogDraftService,
    private readonly completion: AdminOperationCompletionPort,
  ) {}

  public async inspect(rawRequest: unknown) {
    const parsed = CatalogDraftInspectRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid catalog draft inspect request");
    }
    const input = {
      releaseId: parsed.data.releaseId,
      resourceKind: parsed.data.resourceKind,
      resourceId: parsed.data.resourceId,
    };
    await this.authorizer.authorizeRead({
      principalId: parsed.data.principalId,
      operationType: "content.draft.inspect",
      input,
    });
    const result = await this.owner.inspect(input);
    if (!result.ok) throw ownerError(result.error);
    return result.value;
  }

  public async applyCatalogDraftCreate(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogDraftCreateInput,
  ): Promise<AdminOperationRecord> {
    CatalogDraftCreateInputSchema.parse(input);
    assertReleaseTarget(operation, input.releaseId);
    const result = await this.owner.create({
      ...input,
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

  public async applyCatalogDraftReplace(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogDraftReplaceInput,
  ): Promise<AdminOperationRecord> {
    CatalogDraftReplaceInputSchema.parse(input);
    assertReleaseTarget(operation, input.releaseId);
    const result = await this.owner.replace({
      ...input,
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

  public async applyCatalogDraftDeactivate(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogDraftDeactivateInput,
  ): Promise<AdminOperationRecord> {
    CatalogDraftDeactivateInputSchema.parse(input);
    assertReleaseTarget(operation, input.releaseId);
    const result = await this.owner.deactivate({
      ...input,
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
    value: {
      readonly resourceKind: string;
      readonly resourceId: string;
      readonly operationKind: string;
      readonly beforeRevision: string;
      readonly afterRevision: string;
      readonly beforeData: Readonly<Record<string, unknown>> | null;
      readonly afterData: Readonly<Record<string, unknown>>;
      readonly replayed: boolean;
    },
  ): Promise<AdminOperationRecord> {
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: `CATALOG_${value.resourceKind}`,
      resourceId: value.resourceId,
      beforeData: value.beforeData ?? { absent: true },
      afterData: value.afterData,
      result: {
        operationKind: value.operationKind,
        resourceKind: value.resourceKind,
        resourceId: value.resourceId,
        beforeRevision: value.beforeRevision,
        afterRevision: value.afterRevision,
        ownerReplayed: value.replayed,
      },
    });
  }
}
