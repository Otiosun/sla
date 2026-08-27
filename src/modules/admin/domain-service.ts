import type { EconomyService } from "../economy/service.js";
import { parsePlayerId, type PlayerId } from "../../shared-kernel/ids.js";
import type { AppError } from "../../shared-kernel/result.js";
import type { AdminOperationRecord } from "./contracts.js";
import type {
  AdminInventoryAdjustInput,
  AdminWalletAdjustInput,
} from "./domain-contracts.js";
import type { AdminDomainOperationPort } from "./domain-ports.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminOperationCompletionPort } from "./ports.js";

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) {
    throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid player id");
  }
  return parsed.value;
}

function requiredReason(operation: AdminOperationRecord): string {
  if (operation.reason === null || operation.reason.trim().length === 0) {
    throw new AdminError(ADMIN_ERROR_CODES.REASON_REQUIRED, "Admin domain mutation requires reason");
  }
  return operation.reason;
}

function ownerError(error: AppError): AdminError {
  if (error.code === "IDEMPOTENCY_KEY_INVALID") {
    return new AdminError(ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, error.message, error.details);
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

function assertPlayerTarget(operation: AdminOperationRecord, targetPlayerId: string): void {
  if (operation.targetType !== "PLAYER" || operation.targetId !== targetPlayerId) {
    throw new AdminError(
      ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
      "Admin operation target no longer matches domain input",
    );
  }
}

export class AdminDomainOperationService implements AdminDomainOperationPort {
  public constructor(
    private readonly economy: EconomyService,
    private readonly completion: AdminOperationCompletionPort,
  ) {}

  public async applyInventoryAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminInventoryAdjustInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const delta = BigInt(input.delta);
    const quantity = delta < 0n ? -delta : delta;
    const result =
      delta > 0n
        ? await this.economy.addItem({
            playerId: playerId(input.playerId),
            itemId: input.itemId,
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
            playerId: playerId(input.playerId),
            itemId: input.itemId,
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
    const before = after - delta;
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "PLAYER_INVENTORY_ITEM",
      resourceId: input.itemId,
      beforeData: {
        playerId: input.playerId,
        itemId: input.itemId,
        quantity: before.toString(),
      },
      afterData: {
        playerId: input.playerId,
        itemId: input.itemId,
        quantity: after.toString(),
      },
      result: {
        delta: delta.toString(),
        balanceAfter: after.toString(),
        ledgerId: result.value.ledgerId,
        ownerReplayed: result.value.replayed,
      },
    });
  }

  public async applyWalletAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminWalletAdjustInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const delta = BigInt(input.delta);
    const amount = delta < 0n ? -delta : delta;
    const result =
      delta > 0n
        ? await this.economy.creditWallet({
            playerId: playerId(input.playerId),
            currencyId: input.currencyId,
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
            playerId: playerId(input.playerId),
            currencyId: input.currencyId,
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
    const before = after - delta;
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "PLAYER_WALLET_CURRENCY",
      resourceId: input.currencyId,
      beforeData: {
        playerId: input.playerId,
        currencyId: input.currencyId,
        amount: before.toString(),
      },
      afterData: {
        playerId: input.playerId,
        currencyId: input.currencyId,
        amount: after.toString(),
      },
      result: {
        delta: delta.toString(),
        balanceAfter: after.toString(),
        ledgerId: result.value.ledgerId,
        ownerReplayed: result.value.replayed,
      },
    });
  }
}
