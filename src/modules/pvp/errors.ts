import { appError, type AppError } from "../../shared-kernel/result.js";
import type { PvpChallengeError } from "./challenge.js";

export function pvpPlayerIneligible(reason: string, playerId: string): AppError {
  return appError("PLAYER_INELIGIBLE", "Player is not eligible for PVP", {
    reason,
    playerId,
  });
}

export function pvpFlowBlocked(reason: string): AppError {
  return appError("FLOW_BLOCKED", "PVP flow is blocked", { reason });
}

export function pvpActionInvalid(reason: string): AppError {
  return appError("ACTION_INVALID", "PVP action is invalid", { reason });
}

export function mapPvpChallengeError(error: PvpChallengeError): AppError {
  switch (error.code) {
    case "PVP_CHALLENGE_IDEMPOTENCY_CONFLICT":
      return appError("FINGERPRINT_MISMATCH", error.message, error.details);
    case "PVP_CHALLENGE_ACTOR_FORBIDDEN":
      return pvpActionInvalid("challenge-actor-forbidden");
    case "PVP_CHALLENGE_NOT_OPEN":
      return pvpFlowBlocked("challenge-not-open");
    case "PVP_CHALLENGE_EXPIRED":
      return pvpFlowBlocked("challenge-expired");
    case "PVP_CHALLENGE_NOT_EXPIRED":
      return pvpFlowBlocked("challenge-not-expired");
    case "PVP_CHALLENGE_SELF_TARGET":
      return pvpActionInvalid("self-challenge");
    case "PVP_CHALLENGE_INVALID":
      return appError("VALIDATION_FAILED", error.message, error.details);
  }
}
