import { appError } from "../../shared-kernel/result.js";

export const sceneProofInvalid = (message: string) => appError("VALIDATION_FAILED", message);

export const sceneProofRequired = () =>
  appError("ACTION_INVALID", "A 50-word scene in the current area is required", {
    userMessage:
      "Essa ação precisa de uma cena com pelo menos 50 palavras na área atual. O /comando pode ficar no começo, no meio ou no fim da própria cena.",
  });

export const worldServiceNestedOnly = () =>
  appError("ACTION_INVALID", "PC is only available inside an active Pokémon Center visit");

export const worldServiceVisitConflict = () =>
  appError("INVALID_STATE_TRANSITION", "Another world service visit is already active");

export const worldServiceVisitNotFound = () =>
  appError("NOT_FOUND", "World service visit is not active");

export const worldServiceRevisionConflict = (expectedRevision: bigint) =>
  appError("REVISION_CONFLICT", "World service session revision changed", {
    expectedRevision: expectedRevision.toString(),
  });
