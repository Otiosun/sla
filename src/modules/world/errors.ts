import { type AppError, appError } from "../../shared-kernel/result.js";

export function worldNotReady(message: string): AppError {
  return appError("NOT_FOUND", message);
}

export function worldValidationError(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError {
  return appError("VALIDATION_FAILED", message, details);
}

export function locationRevisionConflict(expectedRevision: bigint): AppError {
  return appError("REVISION_CONFLICT", "Player location changed concurrently", {
    expectedRevision: expectedRevision.toString(),
  });
}

export function relocationRequired(areaId: string, relocationAreaId: string | null): AppError {
  return appError("ACTION_INVALID", "Current area is inactive in the active content release", {
    areaId,
    relocationAreaId,
    requiresRelocation: true,
  });
}

export function travelCooldown(availableAt: Date): AppError {
  return appError("ACTION_INVALID", "Travel is temporarily unavailable after arrival", {
    availableAt: availableAt.toISOString(),
  });
}
