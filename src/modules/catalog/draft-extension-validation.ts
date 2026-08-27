import {
  RewardProgramSchema,
  type ValidationIssue,
  type ValidationReport,
} from "./contracts.js";
import type { CatalogSnapshotWithEffects } from "./validation.js";

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message };
}

function requireCoverage(
  issues: ValidationIssue[],
  category: "effects" | "rewards",
  parentIds: readonly string[] | undefined,
  currentIds: readonly string[],
): void {
  if (parentIds === undefined) return;
  const current = new Set(currentIds);
  for (const id of parentIds) {
    if (!current.has(id)) {
      issues.push(
        issue(
          "RELEASE_SNAPSHOT_INCOMPLETE",
          `release.${category}`,
          `Revision for parent identity ${id} is missing from the child release snapshot`,
        ),
      );
    }
  }
}

export function validateCatalogDraftExtensions(
  snapshot: CatalogSnapshotWithEffects,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const rewards = snapshot.rewards ?? [];
  const allItemIds = new Set(snapshot.items.map((entry) => entry.itemId));
  const activeItemIds = new Set(
    snapshot.items.filter((entry) => entry.active).map((entry) => entry.itemId),
  );

  for (const [rewardIndex, reward] of rewards.entries()) {
    const parsed = RewardProgramSchema.safeParse(reward.program);
    if (!parsed.success) {
      for (const zodIssue of parsed.error.issues) {
        const suffix = zodIssue.path.length === 0 ? "" : `.${zodIssue.path.join(".")}`;
        issues.push(
          issue(
            "REWARD_PROGRAM_INVALID",
            `rewards.${rewardIndex}.program${suffix}`,
            zodIssue.message,
          ),
        );
      }
      continue;
    }

    for (const [grantIndex, grant] of parsed.data.grants.entries()) {
      if (grant.kind !== "ITEM") continue;
      if (!allItemIds.has(grant.itemId)) {
        issues.push(
          issue(
            "REWARD_ITEM_MISSING",
            `rewards.${rewardIndex}.program.grants.${grantIndex}.itemId`,
            "Reward item is absent from this release",
          ),
        );
      } else if (reward.active && !activeItemIds.has(grant.itemId)) {
        issues.push(
          issue(
            "ACTIVE_REWARD_ITEM_INACTIVE",
            `rewards.${rewardIndex}.program.grants.${grantIndex}.itemId`,
            "Active reward references an inactive item",
          ),
        );
      }
    }
  }

  if (snapshot.parentCoverage !== null) {
    requireCoverage(
      issues,
      "effects",
      snapshot.parentCoverage.effects,
      snapshot.effects.map((entry) => entry.effectId),
    );
    requireCoverage(
      issues,
      "rewards",
      snapshot.parentCoverage.rewards,
      rewards.map((entry) => entry.rewardId),
    );
  }

  return { valid: issues.length === 0, issues };
}
