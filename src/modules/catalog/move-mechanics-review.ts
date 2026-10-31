/**
 * Review-only import boundary: never equate a PokéAPI move with a supported
 * battle engine effect just because the name/power/PP exist.
 */
export interface ExternalMoveMechanics {
  readonly name: string;
  readonly power: number | null;
  readonly accuracy: number | null;
  readonly pp: number | null;
  readonly priority: number;
  readonly type: { readonly name: string };
  readonly damage_class: { readonly name: string };
  readonly effect_chance?: number | null;
  readonly stat_changes?: readonly unknown[];
  readonly target?: { readonly name: string };
  readonly meta?: {
    readonly category?: { readonly name: string };
    readonly ailment?: { readonly name: string };
    readonly min_hits?: number | null;
    readonly max_hits?: number | null;
    readonly min_turns?: number | null;
    readonly max_turns?: number | null;
    readonly drain?: number;
    readonly healing?: number;
    readonly flinch_chance?: number;
    readonly crit_rate?: number;
    readonly stat_chance?: number;
  } | null;
}

export type MoveEffectReview = {
  readonly slug: string;
  readonly category: "PHYSICAL" | "SPECIAL" | "STATUS";
  readonly typeSlug: string;
  readonly power: number | null;
  readonly accuracy: number | null;
  readonly maxPp: number | null;
  readonly priority: number;
  readonly reviewReasons: readonly string[];
  /**
   * A candidate only. Battle engine functionality, versioned effect programs,
   * priority/targeting and UAT must be tested before a move is publishable.
   */
  readonly basicDamageCandidate: boolean;
};

/**
 * Metadata often reports "damage" for moves whose custom mechanics live in
 * other data (Fly, U-turn, Focus Punch, False Swipe, etc.). Do not infer
 * standard battle support from their power/accuracy alone.
 * This conservative set only identifies candidates for manual verification.
 */
const BASIC_DAMAGE_REVIEW_CANDIDATES = new Set([
  "tackle",
  "pound",
  "scratch",
  "vine-whip",
  "water-gun",
  "gust",
  "aqua-tail",
  "dragon-claw",
  "dragon-pulse",
  "drill-peck",
  "fairy-wind",
  "horn-attack",
  "hydro-pump",
  "megahorn",
  "peck",
  "power-whip",
  "seed-bomb",
  "slam",
  "wing-attack",
  "ember",
]);

const KNOWN_CATEGORY: Record<string, MoveEffectReview["category"]> = {
  physical: "PHYSICAL",
  special: "SPECIAL",
  status: "STATUS",
};
export function classifyMoveForBattleReview(raw: ExternalMoveMechanics): MoveEffectReview {
  const category = KNOWN_CATEGORY[raw.damage_class.name];
  if (
    !category ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(raw.name) ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(raw.type.name) ||
    !Number.isInteger(raw.priority) ||
    raw.priority < -7 ||
    raw.priority > 7
  ) {
    throw new Error("Invalid source move identity, type or priority");
  }
  const reasons: string[] = [];
  const meta = raw.meta;
  if (category === "STATUS") reasons.push("STATUS_MOVE_EFFECT");
  if (!BASIC_DAMAGE_REVIEW_CANDIDATES.has(raw.name)) {
    reasons.push("UNREVIEWED_MOVE_SPECIFIC_MECHANICS");
  }
  if (raw.power === null || raw.power <= 0) reasons.push("NON_STANDARD_POWER");
  if (raw.pp === null || !Number.isInteger(raw.pp) || raw.pp < 1) reasons.push("PP_SPECIAL");
  if (raw.accuracy === null || raw.accuracy < 1 || raw.accuracy > 100)
    reasons.push("ACCURACY_SPECIAL");
  if (raw.target?.name !== "selected-pokemon") reasons.push("TARGETING_RULES");
  if (meta?.category?.name !== "damage") reasons.push("SPECIAL_EFFECT_CATEGORY");
  if (meta?.ailment?.name !== "none") reasons.push("AILMENT_OR_UNKNOWN");
  if ((raw.effect_chance ?? 0) !== 0) reasons.push("SECONDARY_EFFECT");
  if ((raw.stat_changes?.length ?? 0) > 0) reasons.push("STAT_CHANGES");
  if (meta?.min_hits != null || meta?.max_hits != null) reasons.push("MULTI_HIT");
  if (meta?.min_turns != null || meta?.max_turns != null) reasons.push("MULTI_TURN");
  if ((meta?.drain ?? 0) !== 0 || (meta?.healing ?? 0) !== 0) reasons.push("DRAIN_OR_HEAL");
  if (
    (meta?.flinch_chance ?? 0) !== 0 ||
    (meta?.crit_rate ?? 0) !== 0 ||
    (meta?.stat_chance ?? 0) !== 0
  )
    reasons.push("EXTRA_BATTLE_EFFECT");
  // All output remains a review proposal: basic candidates are not auto-seeded.
  return {
    slug: raw.name,
    category,
    typeSlug: raw.type.name,
    power: raw.power,
    accuracy: raw.accuracy,
    maxPp: raw.pp,
    priority: raw.priority,
    reviewReasons: reasons,
    basicDamageCandidate: reasons.length === 0,
  };
}
