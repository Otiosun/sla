import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { ExplorationWorldAdmission } from "./expedition-world-admission.js";

/**
 * Only a trusted, release-pinned, time/surface/unlock-filtered catalog adapter
 * may produce these eligible entries. An area-level preview alone cannot
 * authorize a hunt or deduct expedition minutes.
 */
export interface EligibleExpeditionEncounterEntry {
  readonly entryId: string;
  readonly speciesId: string;
  readonly formId: string;
  readonly weight: number;
}

export interface PinnedEligibleExpeditionEncounterPool {
  readonly contentReleaseId: string;
  readonly areaId: string;
  readonly entries: readonly EligibleExpeditionEncounterEntry[];
}

export interface WeightedExpeditionEncounterEntry extends EligibleExpeditionEncounterEntry {
  readonly effectiveWeight: number;
}

export interface WeightedExpeditionEncounterPool {
  readonly contentReleaseId: string;
  readonly areaId: string;
  readonly targetSpeciesId: string | null;
  readonly entries: readonly WeightedExpeditionEncounterEntry[];
  readonly totalEffectiveWeight: number;
}

function hiddenTargetFailure(): Result<never> {
  // Do not distinguish an unseen species from a known species unavailable in
  // the current table. That difference could leak unreleased encounter content.
  return err(
    appError("FLOW_BLOCKED", "Directed encounter target is not available in this search", {
      userMessage: "Não é possível procurar esse Pokémon aqui e agora. Consulte a RotomDex.",
    }),
  );
}

/**
 * Calculates V1.2's exact x3 targeted-weight policy. When the target has
 * original probability p, its new chance is 3p/(1+2p). No 50% cap or free
 * reroll. Multiple entries/forms of the same species each receive x3 weight.
 *
 * This pure calculation does not charge time, create an encounter or authorize
 * the underlying published-table inputs: the orchestrator must revalidate them
 * inside its canonical World/expedition transaction before applying effects.
 */
export function prepareExpeditionEncounterWeights(input: {
  readonly admission: Pick<ExplorationWorldAdmission, "contentReleaseId" | "currentAreaId">;
  readonly pool: PinnedEligibleExpeditionEncounterPool;
  /** Server-side seen OR captured species identities; never player-supplied. */
  readonly knownSpeciesIds: readonly string[];
  readonly targetSpeciesId: string | null;
}): Result<WeightedExpeditionEncounterPool> {
  const { admission, pool, targetSpeciesId } = input;
  if (
    pool.contentReleaseId.length === 0 ||
    pool.contentReleaseId !== admission.contentReleaseId ||
    pool.areaId !== admission.currentAreaId
  ) {
    return err(
      appError("FLOW_BLOCKED", "Encounter pool is not pinned to the current expedition World", {
        userMessage: "O mapa de encontros mudou. Atualize a RotomDex antes de buscar.",
      }),
    );
  }

  if (
    targetSpeciesId !== null &&
    (targetSpeciesId.length === 0 ||
      !input.knownSpeciesIds.includes(targetSpeciesId) ||
      !pool.entries.some((entry) => entry.speciesId === targetSpeciesId))
  ) {
    return hiddenTargetFailure();
  }

  if (pool.entries.length === 0) {
    return err(
      appError("FLOW_BLOCKED", "No eligible encounters remain in the trusted filtered table", {
        userMessage: "Ainda não há Pokémon disponíveis para buscar nesta área e horário.",
      }),
    );
  }

  const seenEntryIds = new Set<string>();
  let totalEffectiveWeight = 0;
  const entries: WeightedExpeditionEncounterEntry[] = [];

  for (const entry of pool.entries) {
    if (
      entry.entryId.trim().length === 0 ||
      entry.speciesId.trim().length === 0 ||
      entry.formId.trim().length === 0 ||
      seenEntryIds.has(entry.entryId) ||
      !Number.isSafeInteger(entry.weight) ||
      entry.weight <= 0
    ) {
      return err(appError("VALIDATION_FAILED", "Encounter catalog has invalid entry weights"));
    }
    seenEntryIds.add(entry.entryId);

    const multiplier = targetSpeciesId === entry.speciesId ? 3 : 1;
    const effectiveWeight = entry.weight * multiplier;
    if (
      !Number.isSafeInteger(effectiveWeight) ||
      !Number.isSafeInteger(totalEffectiveWeight + effectiveWeight)
    ) {
      return err(appError("VALIDATION_FAILED", "Encounter weights exceed the safe integer range"));
    }
    totalEffectiveWeight += effectiveWeight;
    entries.push({ ...entry, effectiveWeight });
  }

  return ok({
    contentReleaseId: pool.contentReleaseId,
    areaId: pool.areaId,
    targetSpeciesId,
    entries,
    totalEffectiveWeight,
  });
}

/** Deterministic draw with a trusted RNG. Never obtain the roll from a chat message. */
export function drawExpeditionEncounterEntry(input: {
  readonly pool: WeightedExpeditionEncounterPool;
  readonly nextInt: (upperExclusive: number) => number;
}): Result<EligibleExpeditionEncounterEntry> {
  const { pool } = input;
  let accumulatedWeight = 0;
  for (const entry of pool.entries) {
    if (!Number.isSafeInteger(entry.effectiveWeight) || entry.effectiveWeight <= 0) {
      return err(appError("VALIDATION_FAILED", "Prepared encounter weights are invalid"));
    }
    accumulatedWeight += entry.effectiveWeight;
    if (!Number.isSafeInteger(accumulatedWeight)) {
      return err(appError("VALIDATION_FAILED", "Prepared encounter weight sum is invalid"));
    }
  }
  if (
    !Number.isSafeInteger(pool.totalEffectiveWeight) ||
    pool.totalEffectiveWeight <= 0 ||
    accumulatedWeight !== pool.totalEffectiveWeight
  ) {
    return err(appError("VALIDATION_FAILED", "Prepared encounter weight sum is inconsistent"));
  }

  const roll = input.nextInt(pool.totalEffectiveWeight);
  if (!Number.isSafeInteger(roll) || roll < 0 || roll >= pool.totalEffectiveWeight) {
    return err(appError("ACTION_INVALID", "Trusted encounter RNG generated an invalid draw"));
  }

  let cumulative = 0;
  for (const entry of pool.entries) {
    cumulative += entry.effectiveWeight;
    if (roll < cumulative) {
      return ok({
        entryId: entry.entryId,
        speciesId: entry.speciesId,
        formId: entry.formId,
        weight: entry.weight,
      });
    }
  }
  return err(appError("ACTION_INVALID", "Encounter draw could not be resolved"));
}
