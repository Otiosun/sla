import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { WorldLocationView } from "../world/contracts.js";
import { EXPEDITION_DURATION_MINUTES } from "./expedition-clock.js";
import type { ExpeditionSnapshot } from "./expedition-state.js";

export type AutonomousFacilityAction = "HEAL" | "SHOP";

export interface AutonomousFacilityAdmission {
  readonly action: AutonomousFacilityAction;
  readonly requiredFacility: "POKEMON_CENTER" | "POKEMART";
  /** Internal expedition minutes, not World travel cooldown or wall-clock time. */
  readonly actionMinutes: number;
}

const HEALING_INTERNAL_MINUTES = 30;

/**
 * Pure V1.4 service admission. The future orchestrator must still check
 * ACTIVE/COMPLETE player access, current battle locks, the canonical World
 * release and facility policies under the same transaction as the action,
 * expedition clock and idempotency receipt.
 *
 * This does NOT bypass Journey's 50-word scene rule: it applies only to an
 * explicitly ACTIVE autonomous expedition with the correct persisted cursor.
 */
export function inspectAutonomousFacilityAction(input: {
  readonly expedition: Pick<
    ExpeditionSnapshot,
    "playerId" | "currentAreaId" | "phase" | "endReason" | "elapsedMinutes"
  >;
  readonly location: Pick<
    WorldLocationView,
    "playerId" | "areaId" | "contentReleaseId" | "facilities" | "requiresRelocation"
  >;
  readonly pinnedContentReleaseId: string;
  readonly action: AutonomousFacilityAction;
  readonly hasActiveBattle: boolean;
}): Result<AutonomousFacilityAdmission> {
  const { expedition, location } = input;
  if (
    expedition.phase !== "ACTIVE" ||
    expedition.endReason !== null ||
    !Number.isSafeInteger(expedition.elapsedMinutes) ||
    expedition.elapsedMinutes < 1 ||
    expedition.elapsedMinutes >= EXPEDITION_DURATION_MINUTES
  ) {
    return err(
      appError("FLOW_BLOCKED", "An ACTIVE expedition with available time is required", {
        userMessage: "Retome uma expedição ativa antes de usar esse serviço.",
      }),
    );
  }

  if (
    location.playerId !== expedition.playerId ||
    location.areaId !== expedition.currentAreaId ||
    location.requiresRelocation ||
    input.pinnedContentReleaseId.length === 0 ||
    location.contentReleaseId !== input.pinnedContentReleaseId
  ) {
    return err(
      appError("FLOW_BLOCKED", "Expedition World cursor or release is out of date", {
        userMessage: "Sua localização mudou. Consulte a RotomDex antes de continuar.",
      }),
    );
  }

  if (input.hasActiveBattle) {
    return err(
      appError("FLOW_BLOCKED", "Cannot use an autonomous facility during battle", {
        userMessage: "Conclua a batalha antes de usar este serviço.",
      }),
    );
  }

  const requiredFacility = input.action === "HEAL" ? "POKEMON_CENTER" : "POKEMART";
  if (!location.facilities?.includes(requiredFacility)) {
    return err(
      appError("FLOW_BLOCKED", "Requested facility is absent from the active World area", {
        userMessage: "Este serviço não está disponível na área atual.",
      }),
    );
  }

  const actionMinutes = input.action === "HEAL" ? HEALING_INTERNAL_MINUTES : 0;
  if (actionMinutes > EXPEDITION_DURATION_MINUTES - expedition.elapsedMinutes) {
    return err(
      appError("FLOW_BLOCKED", "Insufficient expedition clock for facility action", {
        userMessage: "Não há tempo suficiente na expedição para usar este serviço.",
      }),
    );
  }

  return ok({ action: input.action, requiredFacility, actionMinutes });
}
