import { appError, type AppError } from "../../shared-kernel/result.js";

export function captureValidationError(message: string, details?: unknown): AppError {
  return appError("VALIDATION_FAILED", message, details);
}

export function captureNotFound(message = "Capture encounter was not found"): AppError {
  return appError("ACTION_INVALID", message);
}

export function captureNotReady(message: string, details?: unknown): AppError {
  return appError("ACTION_INVALID", message, details);
}

export function captureRevisionConflict(expectedRevision: bigint): AppError {
  return appError("VERSION_CONFLICT", "Encounter revision is stale", {
    expectedRevision: expectedRevision.toString(),
  });
}

export function captureIdempotencyMismatch(): AppError {
  return appError(
    "IDEMPOTENCY_CONFLICT",
    "Capture idempotency key is already bound to different semantic input",
  );
}

export function captureInsufficientBall(ballItemId: string): AppError {
  return appError("ACTION_INVALID", "Required capture Ball is not available", { ballItemId });
}

export function captureIntegrityError(message: string): AppError {
  return appError("INVARIANT_VIOLATION", message);
}
