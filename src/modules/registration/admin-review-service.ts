import type { AdminPreparedOperation, AdminTarget } from "../admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../admin/errors.js";
import type { AdminOperationCompletionPort } from "../admin/ports.js";
import type { AdminSourceChannel } from "../admin/reception-operation-definitions.js";
import type { AdminService } from "../admin/service.js";
import { appError, err, type Result } from "../../shared-kernel/result.js";
import type { RegistrationRevisionRecord } from "./ports.js";
import type { RegistrationService } from "./service.js";

interface AdminReviewBoundary {
  authorizeRead(rawRequest: unknown): Promise<AdminTarget>;
  prepareMutation(rawRequest: unknown): Promise<AdminPreparedOperation>;
}

interface RegistrationReviewBoundary {
  getReview(reviewId: string): ReturnType<RegistrationService["getReview"]>;
  requestChanges(
    input: Parameters<RegistrationService["requestChanges"]>[0],
  ): ReturnType<RegistrationService["requestChanges"]>;
  approve(
    input: Parameters<RegistrationService["approve"]>[0],
  ): ReturnType<RegistrationService["approve"]>;
  reject(
    input: Parameters<RegistrationService["reject"]>[0],
  ): ReturnType<RegistrationService["reject"]>;
}

export interface AuditedRegistrationReviewDependencies {
  readonly admin: Pick<AdminService, "authorizeRead" | "prepareMutation"> | AdminReviewBoundary;
  readonly registration: RegistrationReviewBoundary;
  readonly completion: AdminOperationCompletionPort;
}

export interface AuditedRegistrationReviewReadInput {
  readonly principalId: string;
  readonly reviewId: string;
  readonly sourceChannel: AdminSourceChannel;
}

export interface AuditedRegistrationReviewDecisionInput extends AuditedRegistrationReviewReadInput {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

type Decision = "REQUEST_CHANGES" | "APPROVE" | "REJECT";

function adminFailure(error: unknown): Result<never> {
  if (!(error instanceof AdminError)) throw error;

  if (
    error.code === ADMIN_ERROR_CODES.AUTHORIZATION_DENIED ||
    error.code === ADMIN_ERROR_CODES.PRINCIPAL_DISABLED ||
    error.code === ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND
  ) {
    return err(appError("PLAYER_INELIGIBLE", error.message, error.details));
  }
  if (error.code === ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT) {
    return err(appError("FINGERPRINT_MISMATCH", error.message, error.details));
  }
  if (
    error.code === ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED ||
    error.code === ADMIN_ERROR_CODES.INVALID_INPUT
  ) {
    return err(appError("VALIDATION_FAILED", error.message, error.details));
  }
  return err(appError("ACTION_INVALID", error.message, error.details));
}

function evidence(review: RegistrationRevisionRecord): Readonly<Record<string, unknown>> {
  return {
    id: review.id,
    playerId: review.playerId,
    sequenceNo: review.sequenceNo,
    status: review.status,
    revision: review.revision,
    snapshot: { ...review.snapshot },
  };
}

function operationType(decision: Decision): string {
  if (decision === "REQUEST_CHANGES") return "registration.review.request_changes";
  if (decision === "APPROVE") return "registration.review.approve";
  return "registration.review.reject";
}

export class AuditedRegistrationReviewService {
  public constructor(private readonly dependencies: AuditedRegistrationReviewDependencies) {}

  public async getReview(
    input: AuditedRegistrationReviewReadInput,
  ): Promise<Result<RegistrationRevisionRecord>> {
    const review = await this.dependencies.registration.getReview(input.reviewId);
    if (!review.ok) return review;

    try {
      await this.dependencies.admin.authorizeRead({
        principalId: input.principalId,
        operationType: "registration.review.read",
        input: {
          reviewId: review.value.id,
          playerId: review.value.playerId,
          sourceChannel: input.sourceChannel,
        },
      });
    } catch (error) {
      return adminFailure(error);
    }
    return review;
  }

  public requestChanges(
    input: AuditedRegistrationReviewDecisionInput,
  ): Promise<Result<RegistrationRevisionRecord>> {
    return this.decide(input, "REQUEST_CHANGES");
  }

  public approve(
    input: AuditedRegistrationReviewDecisionInput,
  ): Promise<Result<RegistrationRevisionRecord>> {
    return this.decide(input, "APPROVE");
  }

  public reject(
    input: AuditedRegistrationReviewDecisionInput,
  ): Promise<Result<RegistrationRevisionRecord>> {
    return this.decide(input, "REJECT");
  }

  private async decide(
    input: AuditedRegistrationReviewDecisionInput,
    decision: Decision,
  ): Promise<Result<RegistrationRevisionRecord>> {
    const before = await this.dependencies.registration.getReview(input.reviewId);
    if (!before.ok) return before;

    let prepared: AdminPreparedOperation;
    try {
      prepared = await this.dependencies.admin.prepareMutation({
        principalId: input.principalId,
        operationType: operationType(decision),
        input: {
          reviewId: before.value.id,
          playerId: before.value.playerId,
          sourceChannel: input.sourceChannel,
        },
        expectedRevision: BigInt(input.expectedRevision),
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });
    } catch (error) {
      return adminFailure(error);
    }

    if (prepared.replayed && prepared.operation.status === "APPLIED") {
      return this.dependencies.registration.getReview(input.reviewId);
    }
    if (prepared.operation.status !== "READY") {
      return err(
        appError(
          "ACTION_INVALID",
          `Administrative registration operation cannot execute from ${prepared.operation.status}`,
        ),
      );
    }

    const domainInput = {
      reviewId: input.reviewId,
      expectedRevision: input.expectedRevision,
      actor: { adminPrincipalId: input.principalId },
      idempotencyKey: `admin-operation:${prepared.operation.id}`,
    };
    const decided =
      decision === "APPROVE"
        ? await this.dependencies.registration.approve(domainInput)
        : decision === "REQUEST_CHANGES"
          ? await this.dependencies.registration.requestChanges(domainInput)
          : await this.dependencies.registration.reject(domainInput);
    if (!decided.ok) return decided;

    try {
      await this.dependencies.completion.completeAppliedOperation({
        operation: prepared.operation,
        actorPrincipalId: input.principalId,
        resourceType: "REGISTRATION_REVIEW",
        resourceId: input.reviewId,
        beforeData: evidence(before.value),
        afterData: evidence(decided.value),
        result: {
          reviewId: decided.value.id,
          status: decided.value.status,
          revision: decided.value.revision,
          replayed: decided.value.replayed,
        },
        auditTarget: { type: "REGISTRATION_REVIEW", id: input.reviewId },
        auditMetadata: { sourceChannel: input.sourceChannel },
      });
    } catch (error) {
      return adminFailure(error);
    }

    return decided;
  }
}
