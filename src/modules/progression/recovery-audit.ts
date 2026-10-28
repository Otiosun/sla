/**
 * Pure retrospective progress diagnosis. This deliberately does NOT mutate
 * players, evolve Pokémon, rewrite moves, or grant XP. The next step must
 * reconcile player history against the pinned content release, with a unique
 * idempotency key and an explicit administrative approval.
 */
export interface LevelEvolutionCandidate {
  readonly targetFormId: string;
  readonly requiredLevel: number;
  readonly relativePhysicalStats: "ATTACK_GT_DEFENSE" | "ATTACK_LT_DEFENSE" | "ATTACK_EQ_DEFENSE" | null;
}

export interface RetrospectiveEvolutionAudit {
  readonly state: "NO_ELIGIBLE_RULE" | "ELIGIBLE_TO_REVIEW" | "NEEDS_STAT_REVIEW" | "AMBIGUOUS";
  readonly candidateTargetFormId: string | null;
  readonly detail: string;
}

export function auditOverdueLevelEvolution(input: {
  readonly currentLevel: number;
  readonly candidates: readonly LevelEvolutionCandidate[];
  readonly currentAttack?: number;
  readonly currentDefense?: number;
}): RetrospectiveEvolutionAudit {
  if (!Number.isInteger(input.currentLevel) || input.currentLevel < 1 || input.currentLevel > 100) {
    throw new RangeError("Current level is invalid");
  }
  const reached = input.candidates.filter((rule) => {
    if (!Number.isInteger(rule.requiredLevel) || rule.requiredLevel < 2 || rule.requiredLevel > 100) {
      throw new RangeError("Evolution required level is invalid");
    }
    return rule.requiredLevel <= input.currentLevel;
  });
  if (reached.length === 0) {
    return { state: "NO_ELIGIBLE_RULE", candidateTargetFormId: null, detail: "No LEVEL threshold met" };
  }
  const ready: LevelEvolutionCandidate[] = [];
  let unknown = false;
  for (const rule of reached) {
    if (rule.relativePhysicalStats === null) {
      ready.push(rule);
      continue;
    }
    if (input.currentAttack === undefined || input.currentDefense === undefined) {
      unknown = true;
      continue;
    }
    const atk = input.currentAttack, def = input.currentDefense;
    const ok = rule.relativePhysicalStats === "ATTACK_GT_DEFENSE"
      ? atk > def
      : rule.relativePhysicalStats === "ATTACK_LT_DEFENSE" ? atk < def : atk === def;
    if (ok) ready.push(rule);
  }
  if (ready.length > 1) {
    return { state: "AMBIGUOUS", candidateTargetFormId: null, detail: "Multiple eligible LEVEL targets" };
  }
  if (unknown) {
    return { state: "NEEDS_STAT_REVIEW", candidateTargetFormId: null, detail: "IVs, Nature and battle stats must be derived first" };
  }
  if (ready.length === 0) {
    return { state: "NO_ELIGIBLE_RULE", candidateTargetFormId: null, detail: "Physical-stat condition is not met" };
  }
  return {
    state: "ELIGIBLE_TO_REVIEW",
    candidateTargetFormId: ready[0]?.targetFormId ?? null,
    detail: "Threshold met on existing Pokémon: inspect history before any corrective evolution",
  };
}

export interface HistoricalMoveAudit {
  readonly state: "ALREADY_KNOWN" | "RESOLVED_OR_SKIPPED" | "OFFER_FOR_REVIEW";
  readonly moveId: string;
}

/**
 * Never automatically restore a move previously skipped/replaced by choice.
 * Other older-level records remain candidates, not free grants.
 */
export function auditHistoricalMove(input: {
  readonly moveId: string;
  readonly currentMoveIds: readonly string[];
  readonly hasResolvedOrSkippedHistory: boolean;
}): HistoricalMoveAudit {
  if (input.currentMoveIds.includes(input.moveId)) {
    return { state: "ALREADY_KNOWN", moveId: input.moveId };
  }
  if (input.hasResolvedOrSkippedHistory) {
    return { state: "RESOLVED_OR_SKIPPED", moveId: input.moveId };
  }
  return { state: "OFFER_FOR_REVIEW", moveId: input.moveId };
}
