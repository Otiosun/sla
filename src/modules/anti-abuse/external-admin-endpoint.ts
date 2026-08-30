import {
  AdminMutationRequestSchema,
  type AdminOperationRecord,
  type AdminPreparedOperation,
} from "../admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../admin/errors.js";
import {
  DEFAULT_MUTATION_ADMISSION_POLICIES,
  type MutationAdmissionPort,
  type MutationRatePolicy,
} from "./contracts.js";
import { admitProtectedMutation } from "./admission-helper.js";

export interface AdminMutationOwner {
  prepareMutation(rawRequest: unknown): Promise<AdminPreparedOperation>;
  simulate(operationId: string, actorPrincipalId: string): Promise<AdminOperationRecord>;
  confirm(operationId: string, actorPrincipalId: string): Promise<AdminOperationRecord>;
  approve(operationId: string, actorPrincipalId: string, reason: string): Promise<AdminOperationRecord>;
  apply(operationId: string, actorPrincipalId: string): Promise<AdminOperationRecord>;
}

export class ExternalAdminMutationEndpoint {
  public constructor(
    private readonly owner: AdminMutationOwner,
    private readonly admission: MutationAdmissionPort,
    private readonly policy: MutationRatePolicy = DEFAULT_MUTATION_ADMISSION_POLICIES.admin,
  ) {}

  public async prepareMutation(rawRequest: unknown): Promise<AdminPreparedOperation> {
    const parsed = AdminMutationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) return this.owner.prepareMutation(rawRequest);
    const request = parsed.data;
    await this.admitOrThrow(
      request.principalId,
      "admin.prepare-mutation",
      `${request.principalId}:${request.operationType}:${request.idempotencyKey}`,
      {
        operationType: request.operationType,
        input: request.input,
        reason: request.reason ?? null,
        expectedRevision: request.expectedRevision ?? null,
      },
    );
    return this.owner.prepareMutation(rawRequest);
  }

  public async simulate(operationId: string, actorPrincipalId: string): Promise<AdminOperationRecord> {
    await this.admitLifecycle("admin.simulate", operationId, actorPrincipalId, null);
    return this.owner.simulate(operationId, actorPrincipalId);
  }

  public async confirm(operationId: string, actorPrincipalId: string): Promise<AdminOperationRecord> {
    await this.admitLifecycle("admin.confirm", operationId, actorPrincipalId, null);
    return this.owner.confirm(operationId, actorPrincipalId);
  }

  public async approve(
    operationId: string,
    actorPrincipalId: string,
    reason: string,
  ): Promise<AdminOperationRecord> {
    await this.admitLifecycle("admin.approve", operationId, actorPrincipalId, reason.trim());
    return this.owner.approve(operationId, actorPrincipalId, reason);
  }

  public async apply(operationId: string, actorPrincipalId: string): Promise<AdminOperationRecord> {
    await this.admitLifecycle("admin.apply", operationId, actorPrincipalId, null);
    return this.owner.apply(operationId, actorPrincipalId);
  }

  private async admitLifecycle(
    actionKey: string,
    operationId: string,
    actorPrincipalId: string,
    reason: string | null,
  ): Promise<void> {
    await this.admitOrThrow(
      actorPrincipalId,
      actionKey,
      `${actorPrincipalId}:${actionKey}:${operationId}${reason === null ? "" : `:${reason}`}`,
      { operationId, actorPrincipalId, reason },
    );
  }

  private async admitOrThrow(
    principalId: string,
    actionKey: string,
    dedupeKey: string,
    fingerprintValue: unknown,
  ): Promise<void> {
    const admitted = await admitProtectedMutation(this.admission, {
      subjectKind: "ADMIN_PRINCIPAL",
      subjectId: principalId,
      surface: "ADMIN",
      actionKey,
      dedupeKey,
      fingerprintValue,
      policy: this.policy,
    });
    if (!admitted.ok) {
      throw new AdminError(
        admitted.error.code === "FINGERPRINT_MISMATCH"
          ? ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT
          : ADMIN_ERROR_CODES.INVALID_INPUT,
        admitted.error.message,
      );
    }
    if (!admitted.value.allowed) {
      throw new AdminError(ADMIN_ERROR_CODES.RATE_LIMITED, "Admin mutation rate limit exceeded", {
        retryAfterMs: admitted.value.retryAfterMs,
      });
    }
  }
}
