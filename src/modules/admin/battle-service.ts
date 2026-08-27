import { z } from "zod";
import type { BattleAdminMutationResult } from "../battle/admin-contracts.js";
import type { BattleAdminOwnerService } from "../battle/admin-service.js";
import type { AppError } from "../../shared-kernel/result.js";
import type {
  AdminBattleCorrectStateInput,
  AdminBattleForceCancelInput,
} from "./battle-contracts.js";
import type { AdminBattleOperationPort } from "./battle-ports.js";
import type { AdminOperationRecord } from "./contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminOperationCompletionPort } from "./ports.js";
import type { AdminService } from "./service.js";

const BattleInspectRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    playerId: z.string().uuid(),
    battleId: z.string().uuid(),
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
    throw new AdminError(ADMIN_ERROR_CODES.REASON_REQUIRED, "Battle admin mutation requires reason");
  }
  return operation.reason;
}

function requiredExpectedVersion(operation: AdminOperationRecord): number {
  if (operation.expectedRevision === null) {
    throw new AdminError(
      ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
      "Battle admin mutation requires expected revision",
    );
  }
  const version = Number(operation.expectedRevision);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Battle version is outside JS safe range");
  }
  return version;
}

function assertPlayerTarget(operation: AdminOperationRecord, playerId: string): void {
  if (operation.targetType !== "PLAYER" || operation.targetId !== playerId) {
    throw new AdminError(
      ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
      "Battle admin operation target no longer matches input",
    );
  }
}

export class AdminBattleOperationService implements AdminBattleOperationPort {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly owner: BattleAdminOwnerService,
    private readonly completion: AdminOperationCompletionPort,
  ) {}

  public async inspect(rawRequest: unknown) {
    const parsed = BattleInspectRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid Battle inspect request");
    }
    await this.authorizer.authorizeRead({
      principalId: parsed.data.principalId,
      operationType: "battle.inspect",
      input: { playerId: parsed.data.playerId, battleId: parsed.data.battleId },
    });
    const result = await this.owner.inspect(parsed.data.playerId, parsed.data.battleId);
    if (!result.ok) throw ownerError(result.error);
    return result.value;
  }

  private async completeMutation(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    battleId: string,
    value: BattleAdminMutationResult,
  ): Promise<AdminOperationRecord> {
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "BATTLE",
      resourceId: battleId,
      beforeData: value.beforeState,
      afterData: value.afterState,
      result: {
        operationKind: value.operationKind,
        beforeVersion: value.beforeVersion,
        afterVersion: value.afterVersion,
        ownerReplayed: value.replayed,
        encounterNeedsClose: value.encounterNeedsClose,
      },
    });
  }

  public async applyBattleForceCancel(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminBattleForceCancelInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.owner.forceCancel({
      playerId: input.playerId,
      battleId: input.battleId,
      expectedVersion: requiredExpectedVersion(operation),
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
    return this.completeMutation(operation, actorPrincipalId, input.battleId, result.value);
  }

  public async applyBattleStateCorrection(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminBattleCorrectStateInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.owner.correctState({
      playerId: input.playerId,
      battleId: input.battleId,
      expectedVersion: requiredExpectedVersion(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: {
        sourceType: "ADMIN_OPERATION",
        sourceId: operation.id,
        reason: requiredReason(operation),
        actorType: "ADMIN",
        actorId: operation.principalId,
      },
      correction: {
        participantId: input.participantId,
        ...(input.currentHp === undefined ? {} : { currentHp: input.currentHp }),
        ...(input.majorStatus === undefined ? {} : { majorStatus: input.majorStatus }),
        ...(input.movePp === undefined ? {} : { movePp: input.movePp }),
      },
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completeMutation(operation, actorPrincipalId, input.battleId, result.value);
  }
}
