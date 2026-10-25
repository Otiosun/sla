import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterEnvironmentContext } from "../catalog/encounter-contracts.js";
import { EXPEDITION_DURATION_MINUTES } from "./expedition-clock.js";
import {
  prepareExpeditionEncounterWeights,
  type PinnedEligibleExpeditionEncounterPool,
  type WeightedExpeditionEncounterPool,
} from "./expedition-encounter-weighting.js";
import type { ExpeditionSnapshot } from "./expedition-state.js";
import type { ExplorationWorldAdmission } from "./expedition-world-admission.js";

export const EXPEDITION_HUNT_SEARCH_MINUTES = 30;

export interface ExpeditionHuntPreparation {
  readonly expeditionId: string;
  readonly actionMinutes: typeof EXPEDITION_HUNT_SEARCH_MINUTES;
  readonly requiresFirstAction: boolean;
  readonly pool: WeightedExpeditionEncounterPool;
}

function blocked(message: string, userMessage: string): Result<never> {
  return err(appError("FLOW_BLOCKED", message, { userMessage }));
}

/**
 * V1.2 preflight between V1.1's clock/World and the published pool reader.
 * This does not roll encounters, reserve the first weekly slot or issue a
 * command: the canonical SQL first/next-action transaction must recheck
 * every mutable predicate before charging 30 minutes or creating an Encounter.
 */
export function prepareExpeditionHunt(input: {
  readonly expedition: Pick<
    ExpeditionSnapshot,
    | "expeditionId"
    | "playerId"
    | "period"
    | "currentAreaId"
    | "phase"
    | "elapsedMinutes"
    | "endReason"
    | "consumedWeekKey"
  >;
  readonly admission: Pick<
    ExplorationWorldAdmission,
    "playerId" | "contentReleaseId" | "currentAreaId"
  >;
  readonly pool: PinnedEligibleExpeditionEncounterPool;
  readonly knownSpeciesIds: readonly string[];
  readonly targetSpeciesId: string | null;
  readonly environment: EncounterEnvironmentContext & { readonly timeOfDay: "DAY" | "NIGHT" };
  readonly hasActiveEncounterOrBattle: boolean;
}): Result<ExpeditionHuntPreparation> {
  const { expedition, admission } = input;
  if (
    admission.playerId !== expedition.playerId ||
    admission.currentAreaId !== expedition.currentAreaId ||
    expedition.period !== input.environment.timeOfDay
  ) {
    return blocked(
      "Expedition World or day period changed since preparation",
      "O cenário da busca mudou. Atualize a RotomDex antes de continuar.",
    );
  }

  const preparing =
    expedition.phase === "PREPARING" &&
    expedition.elapsedMinutes === 0 &&
    expedition.consumedWeekKey === null &&
    expedition.endReason === null;
  const active =
    expedition.phase === "ACTIVE" &&
    Number.isSafeInteger(expedition.elapsedMinutes) &&
    expedition.elapsedMinutes > 0 &&
    expedition.elapsedMinutes < EXPEDITION_DURATION_MINUTES &&
    expedition.consumedWeekKey !== null &&
    expedition.endReason === null;
  if (!preparing && !active) {
    return blocked(
      "Expedition is not ready to hunt",
      "Inicie ou retome uma expedição válida antes de procurar Pokémon.",
    );
  }
  if (input.hasActiveEncounterOrBattle) {
    return blocked(
      "Existing encounter or battle must be resolved first",
      "Resolva seu encontro ou batalha atual antes de realizar outra busca.",
    );
  }
  if (EXPEDITION_HUNT_SEARCH_MINUTES > EXPEDITION_DURATION_MINUTES - expedition.elapsedMinutes) {
    return blocked(
      "Not enough internal expedition time for a hunt",
      "Não há mais 30 minutos disponíveis para uma nova busca nesta expedição.",
    );
  }

  const weighed = prepareExpeditionEncounterWeights({
    admission,
    pool: input.pool,
    knownSpeciesIds: input.knownSpeciesIds,
    targetSpeciesId: input.targetSpeciesId,
  });
  if (!weighed.ok) return weighed;
  return ok({
    expeditionId: expedition.expeditionId,
    actionMinutes: EXPEDITION_HUNT_SEARCH_MINUTES,
    requiresFirstAction: preparing,
    pool: weighed.value,
  });
}
