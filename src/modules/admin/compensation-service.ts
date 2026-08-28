import type { EconomyService } from "../economy/service.js";
import type { ProgressionService } from "../progression/service.js";
import { parsePlayerId } from "../../shared-kernel/ids.js";
import type { AppError } from "../../shared-kernel/result.js";
import {
  AdminInventoryAdjustInputSchema,
  AdminTrainerProgressAdjustInputSchema,
  AdminWalletAdjustInputSchema,
} from "./domain-contracts.js";
import {
  isCompensatableAdminOperationType,
  type AdminCompensationInput,
} from "./compensation-contracts.js";
import type {
  AdminCompensationCompletionPort,
  AdminCompensationOperationPort,
} from "./compensation-ports.js";
import type { AdminOperationRecord } from "./contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminOperationRepository } from "./ports.js";

function requiredReason(operation: AdminOperationRecord): string {
  if (operation.reason === null || operation.reason.trim().length === 0) {
    throw new AdminError(ADMIN_ERROR_CODES.REASON_REQUIRED, "Compensation requires a reason");
  }
  return operation.reason;
}

function ownerError(error: AppError): AdminError {
  if (error.code === "IDEMPOTENCY_KEY_INVALID" || error.code === "FINGERPRINT_MISMATCH") {
    return new AdminError(ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, error.message, error.details);
  }
  if (error.code === "NOT_FOUND") {
    return new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, error.message, error.details);
  }
  if (error.code === "VALIDATION_FAILED" || error.code === "INVALID_ID") {
    return new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, error.message, error.details);
  }
  return new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, error.message, {
    ownerCode: error.code,
    ...(error.details ?? {}),
  });
}

function assertSourceTarget(source: AdminOperationRecord, input: AdminCompensationInput): void {
  if (source.targetType !== "PLAYER" || source.targetId !== input.playerId) {
    throw new AdminError(
      ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      "Compensation source does not belong to the authorized player target",
    );
  }
}

function assertCompensationTarget(
  operation: AdminOperationRecord,
  input: AdminCompensationInput,
): void {
  if (operation.targetType !== "PLAYER" || operation.targetId !== input.playerId) {
    throw new AdminError(
      ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
      "Compensation operation target no longer matches input",
    );
  }
}

export class AdminCompensationService implements AdminCompensationOperationPort {
  public constructor(
    private readonly repository: Pick<AdminOperationRepository, "getOperation">,
    private readonly economy: EconomyService,
    private readonly progression: ProgressionService,
    private readonly completion: AdminCompensationCompletionPort,
  ) {}

  public async applyCompensation(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminCompensationInput,
  ): Promise<AdminOperationRecord> {
    assertCompensationTarget(operation, input);
    const source = await this.repository.getOperation(input.sourceOperationId);
    if (source === null) {
      throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Source admin operation not found");
    }
    assertSourceTarget(source, input);
    if (source.status !== "APPLIED") {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
        source.status === "COMPENSATED"
          ? "Source admin operation is already compensated"
          : "Only an APPLIED admin operation can be compensated",
        { sourceStatus: source.status },
      );
    }
    if (!isCompensatableAdminOperationType(source.operationType)) {
      throw new AdminError(
        ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
        "Source admin operation has no semantic compensation handler",
        { sourceOperationType: source.operationType },
      );
    }

    if (source.operationType === "inventory.adjust") {
      const parsed = AdminInventoryAdjustInputSchema.safeParse(source.input);
      if (!parsed.success || parsed.data.playerId !== input.playerId) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Persisted inventory source is invalid");
      }
      const inverseDelta = -BigInt(parsed.data.delta);
      const quantity = inverseDelta < 0n ? -inverseDelta : inverseDelta;
      const player = parsePlayerId(input.playerId);
      if (!player.ok) throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid player id");
      const result =
        inverseDelta > 0n
          ? await this.economy.addItem({
              playerId: player.value,
              itemId: parsed.data.itemId,
              quantity,
              idempotencyKey: operation.id,
              metadata: {
                sourceType: "ADMIN_OPERATION",
                sourceId: operation.id,
                reason: requiredReason(operation),
                actorType: "ADMIN",
                actorId: operation.principalId,
                correlationId: operation.correlationId,
              },
            })
          : await this.economy.consumeItem({
              playerId: player.value,
              itemId: parsed.data.itemId,
              quantity,
              idempotencyKey: operation.id,
              metadata: {
                sourceType: "ADMIN_OPERATION",
                sourceId: operation.id,
                reason: requiredReason(operation),
                actorType: "ADMIN",
                actorId: operation.principalId,
                correlationId: operation.correlationId,
              },
            });
      if (!result.ok) throw ownerError(result.error);
      const after = result.value.quantity;
      const before = after - inverseDelta;
      return this.completion.completeCompensation({
        sourceOperation: source,
        compensationOperation: operation,
        actorPrincipalId,
        compensationKind: "INVERSE_DELTA_V1",
        resourceType: "PLAYER_INVENTORY_ITEM",
        resourceId: parsed.data.itemId,
        beforeData: { playerId: input.playerId, itemId: parsed.data.itemId, quantity: before.toString() },
        afterData: { playerId: input.playerId, itemId: parsed.data.itemId, quantity: after.toString() },
        result: {
          compensatesOperationId: source.id,
          sourceOperationType: source.operationType,
          inverseDelta: inverseDelta.toString(),
          ledgerId: result.value.ledgerId,
          ownerReplayed: result.value.replayed,
        },
      });
    }

    if (source.operationType === "wallet.adjust") {
      const parsed = AdminWalletAdjustInputSchema.safeParse(source.input);
      if (!parsed.success || parsed.data.playerId !== input.playerId) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Persisted wallet source is invalid");
      }
      const inverseDelta = -BigInt(parsed.data.delta);
      const amount = inverseDelta < 0n ? -inverseDelta : inverseDelta;
      const player = parsePlayerId(input.playerId);
      if (!player.ok) throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid player id");
      const result =
        inverseDelta > 0n
          ? await this.economy.creditWallet({
              playerId: player.value,
              currencyId: parsed.data.currencyId,
              amount,
              idempotencyKey: operation.id,
              metadata: {
                sourceType: "ADMIN_OPERATION",
                sourceId: operation.id,
                reason: requiredReason(operation),
                actorType: "ADMIN",
                actorId: operation.principalId,
                correlationId: operation.correlationId,
              },
            })
          : await this.economy.debitWallet({
              playerId: player.value,
              currencyId: parsed.data.currencyId,
              amount,
              idempotencyKey: operation.id,
              metadata: {
                sourceType: "ADMIN_OPERATION",
                sourceId: operation.id,
                reason: requiredReason(operation),
                actorType: "ADMIN",
                actorId: operation.principalId,
                correlationId: operation.correlationId,
              },
            });
      if (!result.ok) throw ownerError(result.error);
      const after = result.value.amount;
      const before = after - inverseDelta;
      return this.completion.completeCompensation({
        sourceOperation: source,
        compensationOperation: operation,
        actorPrincipalId,
        compensationKind: "INVERSE_DELTA_V1",
        resourceType: "PLAYER_WALLET_CURRENCY",
        resourceId: parsed.data.currencyId,
        beforeData: { playerId: input.playerId, currencyId: parsed.data.currencyId, amount: before.toString() },
        afterData: { playerId: input.playerId, currencyId: parsed.data.currencyId, amount: after.toString() },
        result: {
          compensatesOperationId: source.id,
          sourceOperationType: source.operationType,
          inverseDelta: inverseDelta.toString(),
          ledgerId: result.value.ledgerId,
          ownerReplayed: result.value.replayed,
        },
      });
    }

    const parsed = AdminTrainerProgressAdjustInputSchema.safeParse(source.input);
    if (!parsed.success || parsed.data.playerId !== input.playerId) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Persisted progression source is invalid");
    }
    const inverseDelta = -BigInt(parsed.data.delta);
    const result = await this.progression.adjustTrainerProgress({
      playerId: input.playerId,
      delta: Number(inverseDelta),
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
    if (!result.ok) {
      if (result.error.code === "PROGRESSION_IDEMPOTENCY_CONFLICT") {
        throw new AdminError(ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, result.error.message);
      }
      throw new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, result.error.message, {
        ownerCode: result.error.code,
      });
    }
    return this.completion.completeCompensation({
      sourceOperation: source,
      compensationOperation: operation,
      actorPrincipalId,
      compensationKind: "INVERSE_DELTA_V1",
      resourceType: "TRAINER_PROGRESSION",
      resourceId: input.playerId,
      beforeData: {
        playerId: input.playerId,
        progressionPoints: result.value.beforePoints.toString(),
        level: result.value.beforeLevel,
      },
      afterData: {
        playerId: input.playerId,
        progressionPoints: result.value.afterPoints.toString(),
        level: result.value.afterLevel,
      },
      result: {
        compensatesOperationId: source.id,
        sourceOperationType: source.operationType,
        inverseDelta: inverseDelta.toString(),
        rulesetId: result.value.rulesetId,
        activatedUnlockKeys: result.value.activatedUnlockKeys,
        revokedUnlockKeys: result.value.revokedUnlockKeys,
        ownerReplayed: result.value.replayed,
      },
    });
  }
}
