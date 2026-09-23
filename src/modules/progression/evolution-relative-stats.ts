export type RelativePhysicalStatsRequirement =
  | "ATTACK_GT_DEFENSE"
  | "ATTACK_LT_DEFENSE"
  | "ATTACK_EQ_DEFENSE";

export function matchesRelativePhysicalStats(
  requirement: RelativePhysicalStatsRequirement | undefined,
  stats: { readonly attack: number; readonly defense: number },
): boolean {
  if (requirement === undefined) return true;
  if (requirement === "ATTACK_GT_DEFENSE") return stats.attack > stats.defense;
  if (requirement === "ATTACK_LT_DEFENSE") return stats.attack < stats.defense;
  return stats.attack === stats.defense;
}
