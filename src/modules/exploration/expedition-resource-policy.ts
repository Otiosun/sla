import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { ExplorationWorldAdmission } from "./expedition-world-admission.js";

/** Search time in the expedition's internal clock, not real-world minutes. */
export const EXPEDITION_RESOURCE_SEARCH_MINUTES = 60;
export const EXPEDITION_RESOURCE_ROLL_BASIS_POINTS = 10_000;

export interface ExpeditionResourceReward {
  /** Exact ACTIVE item identity verified by a trusted, release-pinned catalog provider. */
  readonly itemId: string;
  readonly quantity: number;
}

export interface ExpeditionResourceOutcome {
  readonly outcomeId: string;
  /** Non-negative integer weight. The full table must sum to 10,000. */
  readonly weightBasisPoints: number;
  /** Null is an explicit "nothing found" outcome; no free replacement draw. */
  readonly reward: ExpeditionResourceReward | null;
}

export interface PinnedExpeditionResourceTable {
  readonly contentReleaseId: string;
  readonly areaId: string;
  readonly outcomes: readonly ExpeditionResourceOutcome[];
}

export interface PreparedExpeditionResourceTable extends PinnedExpeditionResourceTable {
  readonly totalWeightBasisPoints: typeof EXPEDITION_RESOURCE_ROLL_BASIS_POINTS;
}

function invalidTable(): Result<never> {
  return err(
    appError("VALIDATION_FAILED", "Area resource catalog is incomplete or invalid", {
      userMessage: "Não é possível buscar recursos aqui no momento. Consulte a RotomDex.",
    }),
  );
}

/**
 * Pure V1.3 resource-draw preflight. It does NOT approve the source of a table,
 * spend 60 minutes or mint items: the trusted caller must verify publication,
 * release, current area, item identities and action eligibility under the
 * expedition's World/clock/receipt transaction.
 */
export function prepareExpeditionResourceTable(input: {
  readonly admission: Pick<ExplorationWorldAdmission, "contentReleaseId" | "currentAreaId">;
  readonly table: PinnedExpeditionResourceTable;
  /** Item identities verified in the active, release-pinned catalog. */
  readonly approvedItemIds: readonly string[];
}): Result<PreparedExpeditionResourceTable> {
  const { admission, table } = input;
  if (
    table.contentReleaseId.length === 0 ||
    table.contentReleaseId !== admission.contentReleaseId ||
    table.areaId !== admission.currentAreaId
  ) {
    return err(
      appError("FLOW_BLOCKED", "Resource catalog does not match the expedition World cursor", {
        userMessage: "O catálogo de recursos desta área mudou. Atualize a RotomDex.",
      }),
    );
  }
  if (table.outcomes.length === 0) return invalidTable();

  const acceptedItemIds = new Set(input.approvedItemIds);
  const seenOutcomes = new Set<string>();
  let totalWeight = 0;
  for (const outcome of table.outcomes) {
    if (
      outcome.outcomeId.trim().length === 0 ||
      seenOutcomes.has(outcome.outcomeId) ||
      !Number.isSafeInteger(outcome.weightBasisPoints) ||
      outcome.weightBasisPoints <= 0 ||
      outcome.weightBasisPoints > EXPEDITION_RESOURCE_ROLL_BASIS_POINTS
    ) {
      return invalidTable();
    }
    seenOutcomes.add(outcome.outcomeId);
    const reward = outcome.reward;
    if (
      reward !== null &&
      (!acceptedItemIds.has(reward.itemId) ||
        !Number.isSafeInteger(reward.quantity) ||
        reward.quantity < 1)
    ) {
      return invalidTable();
    }

    totalWeight += outcome.weightBasisPoints;
    if (!Number.isSafeInteger(totalWeight) || totalWeight > EXPEDITION_RESOURCE_ROLL_BASIS_POINTS) {
      return invalidTable();
    }
  }
  if (totalWeight !== EXPEDITION_RESOURCE_ROLL_BASIS_POINTS) return invalidTable();
  return ok({ ...table, totalWeightBasisPoints: EXPEDITION_RESOURCE_ROLL_BASIS_POINTS });
}

/**
 * Exactly one trusted server RNG call and one outcome, including "nothing".
 * The result is a grant *proposal*, not an inventory mutation. An orchestrator
 * must apply it idempotently in the same transaction as clock/receipt.
 */
export function drawExpeditionResourceOutcome(input: {
  readonly table: PreparedExpeditionResourceTable;
  readonly nextInt: (upperExclusive: number) => number;
}): Result<ExpeditionResourceOutcome> {
  if (
    input.table.totalWeightBasisPoints !== EXPEDITION_RESOURCE_ROLL_BASIS_POINTS ||
    input.table.outcomes.length === 0
  ) {
    return invalidTable();
  }
  let sum = 0;
  for (const outcome of input.table.outcomes) {
    if (!Number.isSafeInteger(outcome.weightBasisPoints) || outcome.weightBasisPoints <= 0) {
      return invalidTable();
    }
    sum += outcome.weightBasisPoints;
  }
  if (sum !== EXPEDITION_RESOURCE_ROLL_BASIS_POINTS) return invalidTable();

  const roll = input.nextInt(EXPEDITION_RESOURCE_ROLL_BASIS_POINTS);
  if (!Number.isSafeInteger(roll) || roll < 0 || roll >= EXPEDITION_RESOURCE_ROLL_BASIS_POINTS) {
    return err(appError("ACTION_INVALID", "Trusted resource RNG generated an invalid draw"));
  }
  let cumulative = 0;
  for (const outcome of input.table.outcomes) {
    cumulative += outcome.weightBasisPoints;
    if (roll < cumulative) {
      return ok({
        outcomeId: outcome.outcomeId,
        weightBasisPoints: outcome.weightBasisPoints,
        reward: outcome.reward,
      });
    }
  }
  return err(appError("ACTION_INVALID", "Resource draw could not be resolved"));
}
