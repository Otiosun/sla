import { type AppError, appError } from "../../shared-kernel/result.js";

export function economyValidationError(label: string, details?: unknown): AppError {
  return appError(
    "VALIDATION_FAILED",
    `${label} is invalid`,
    details === undefined ? undefined : { details },
  );
}

export function insufficientInventory(itemId: string, requested: bigint): AppError {
  return appError("ACTION_INVALID", "Inventory balance is insufficient", {
    itemId,
    requested: requested.toString(),
  });
}

export function insufficientWallet(currencyId: string, requested: bigint): AppError {
  return appError("ACTION_INVALID", "Wallet balance is insufficient", {
    currencyId,
    requested: requested.toString(),
  });
}

export function purchaseOfferNotFound(contentReleaseId: string, offerKey: string): AppError {
  return appError("NOT_FOUND", "Purchase offer was not found", { contentReleaseId, offerKey });
}

export function idempotencyReplayMismatch(): AppError {
  return appError(
    "IDEMPOTENCY_KEY_INVALID",
    "Idempotency key was already used for a different economy operation",
  );
}
