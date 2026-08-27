import { z } from "zod";
import type { EncounterAdminOwnerService } from "../encounter/admin-service.js";
import { parseEncounterId, parsePlayerId } from "../../shared-kernel/ids.js";
import type { AppError } from "../../shared-kernel/result.js";
import type { AdminOperationRecord } from "./contracts.js";
import type { AdminEncounterCloseInput } from "./domain-contracts.js";
import type { AdminEncounterOperationPort } from "./encounter-ports.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminOperationCompletionPort } from "./ports.js";
import type { AdminService } from "./service.js";

const EncounterInspectRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    playerId: z.string().uuid(),
    encounterId: z.string().uuid(),
  })
  .strict();

function ownerError(error: AppError): AdminError {
  if (error.code === "IDEMPOTENCY_KEY_INVALID" || error.code === "FINGERPRINT_MISMATCH") {
    return new AdminError(ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, error.message, error.details);
  }
  if (error.code === "REVISION_CONFLICT") {
    return new AdminError(ADMIN_ERROR_CODES.REVISION_CONFLICT, error.message, error.details);
  }
  if (error.code === "NOT_FOUND") {
    return new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, error.message, error.details);
  }
  if (error.code === "VALIDATION_FAILED" || error.code === "INVALID_ID") {
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
      "Encounter admin close requires reason",
    );
  }
  return operation.reason;
}

function requiredExpectedRevision(operation: AdminOperationRecord): bigint {
  if (operation.expectedRevision === null) {
    throw new AdminError(
      ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
      "Encounter admin close requires expected revision",
    );
  }
  return operation.expectedRevision;
}

function assertPlayerTarget(operation: AdminOperationRecord, playerId: string): void {
  if (operation.targetType !== "PLAYER" || operation.targetId !== playerId) {
    throw new AdminError(
      ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
      "Encounter admin operation target no longer matches input",
    );
  }
}

function playerId(value: string) {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid player id");
  return parsed.value;
}

function encounterId(value: string) {
  const parsed = parseEncounterId(value);
  if (!parsed.ok) throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid encounter id");
  return parsed.value;
}

export class AdminEncounterOperationService implements AdminEncounterOperationPort {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly owner: EncounterAdminOwnerService,
    private readonly completion: AdminOperationCompletionPort,
  ) {}

  public async inspect(rawRequest: unknown) {
    const parsed = EncounterInspectRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid Encounter inspect request");
    }
    await this.authorizer.authorizeRead({
      principalId: parsed.data.principalId,
      operationType: "encounter.inspect",
      input: { playerId: parsed.data.playerId, encounterId: parsed.data.encounterId },
    });
    const result = await this.owner.inspect(
      playerId(parsed.data.playerId),
      encounterId(parsed.data.encounterId),
    );
    if (!result.ok) throw ownerError(result.error);
    return result.value;
  }

  public async applyEncounterClose(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminEncounterCloseInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.owner.close({
      playerId: playerId(input.playerId),
      encounterId: encounterId(input.encounterId),
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
    const value = result.value;
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "ENCOUNTER",
      resourceId: input.encounterId,
      beforeData: value.beforeState,
      afterData: value.afterState,
      result: {
        operationKind: value.operationKind,
        beforeRevision: value.beforeRevision,
        afterRevision: value.afterRevision,
        ownerReplayed: value.replayed,
      },
    });
  }
}
