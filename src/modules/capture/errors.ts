import { appError, type AppError } from "../../shared-kernel/result.js";

export function captureValidationError(message: string, details?: Readonly<Record<string, unknown>>): AppError {
  return appError("VALIDATION_FAILED", message, details);
}

export function captureNotFound(message = "Capture encounter was not found"): AppError {
  return appError("NOT_FOUND", message);
}

export function captureNotReady(message: string, details?: Readonly<Record<string, unknown>>): AppError {
  return appError("ACTION_INVALID", message, details);
}

export function captureRevisionConflict(expectedRevision: bigint): AppError {
  return appError("REVISION_CONFLICT", "Encounter revision is stale", {
    expectedRevision: expectedRevision.toString(),
  });
}

export function captureBattleVersionConflict(expectedVersion: number): AppError {
  return appError("REVISION_CONFLICT", "Battle version is stale", { expectedVersion });
}

export function captureIdempotencyMismatch(): AppError {
  return appError(
    "FINGERPRINT_MISMATCH",
    "Capture idempotency key is already bound to different semantic input",
  );
}

export function captureInsufficientBall(ballItemId: string): AppError {
  return appError("ACTION_INVALID", "Required capture Ball is not available", { ballItemId });
}

export function captureIntegrityError(message = "Capture could not be completed safely"): AppError {
  return appError("ACTION_INVALID", message);
}
