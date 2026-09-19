import { describe, expect, it } from "vitest";
import {
  buildBalancedZhouliaEncounterPlans,
  ZHOULIA_ENCOUNTER_BALANCE_V1,
} from "../../src/modules/world/zhoulia-encounter-balance.js";

describe("Zhoulia encounter balance V1", () => {
  it("uses an explicit isolated starter-region baseline", () => {
    expect(ZHOULIA_ENCOUNTER_BALANCE_V1).toEqual({
      "zhoulia.area.vila-dos-arrozais": {
        minLevel: 2,
        maxLevel: 5,
        speciesWeight: 100,
      },
      "zhoulia.area.campos-de-yun": {
        minLevel: 4,
        maxLevel: 8,
        speciesWeight: 100,
      },
    });
  });

  it("materializes all seven pools with equal within-pool species weight", () => {
    const plans = buildBalancedZhouliaEncounterPlans();
    expect(plans).toHaveLength(7);
    expect(plans.every((plan) => plan.balancePolicyVersion === 1)).toBe(true);
    for (const plan of plans) {
      expect(plan.entries.length).toBeGreaterThan(0);
      expect(new Set(plan.entries.map((entry) => entry.weight))).toEqual(new Set([100]));
    }
  });

  it("keeps table rarity separate from species weighting", () => {
    const rare = buildBalancedZhouliaEncounterPlans().find((plan) =>
      plan.identity.endsWith(".village-rare"),
    );
    expect(rare?.conditions.rarity).toBe("RARE");
    expect(rare?.entries.every((entry) => entry.weight === 100)).toBe(true);
  });
});
