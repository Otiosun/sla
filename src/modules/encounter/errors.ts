import { appError, type AppError } from "../../shared-kernel/result.js";

export function encounterNotFound(message = "Encounter was not found"): AppError {
  return appError("NOT_FOUND", message);
}

export function encounterNotReady(message: string): AppError {
  return appError("ACTION_INVALID", message);
}

export function encounterRevisionConflict(expectedRevision: bigint): AppError {
  return appError("REVISION_CONFLICT", "Encounter changed concurrently", {
    expectedRevision: expectedRevision.toString(),
  });
}

export function encounterValidationError(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError {
  return appError("VALIDATION_FAILED", message, details);
}
