import type { PlayerId } from "../../shared-kernel/ids.js";
import { type AppError, appError } from "../../shared-kernel/result.js";
import type { OnboardingRecord } from "./contracts.js";

export function playerValidationError(label: string, issues: unknown): AppError {
  return appError("VALIDATION_FAILED", `${label} is invalid`, { issues });
}

export function playerInvalidState(record: OnboardingRecord, expected: string): AppError {
  return appError("FLOW_BLOCKED", "Onboarding state does not allow this operation", {
    state: record.state,
    expected,
  });
}

export function playerRevisionConflict(): AppError {
  return appError("REVISION_CONFLICT", "Onboarding changed concurrently; reload and retry");
}

export function playerNotFound(playerId: PlayerId): AppError {
  return appError("NOT_FOUND", "Player was not found", { playerId });
}
