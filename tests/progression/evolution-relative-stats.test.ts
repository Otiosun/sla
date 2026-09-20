import { describe, expect, it } from "vitest";
import { EvolutionTriggerSchemas } from "../../src/modules/catalog/contracts.js";
import { matchesRelativePhysicalStats } from "../../src/modules/progression/evolution-relative-stats.js";

describe("relative-stat level evolutions", () => {
  it("validates the three supported relative-stat branches", () => {
    for (const relativePhysicalStats of [
      "ATTACK_GT_DEFENSE",
      "ATTACK_LT_DEFENSE",
      "ATTACK_EQ_DEFENSE",
    ] as const) {
      expect(
        EvolutionTriggerSchemas.LEVEL.safeParse({
          level: 20,
          relativePhysicalStats,
        }).success,
      ).toBe(true);
    }
  });

  it("selects Hitmonlee-style Attack greater than Defense", () => {
    expect(
      matchesRelativePhysicalStats("ATTACK_GT_DEFENSE", { attack: 55, defense: 40 }),
    ).toBe(true);
    expect(
      matchesRelativePhysicalStats("ATTACK_GT_DEFENSE", { attack: 40, defense: 55 }),
    ).toBe(false);
  });

  it("selects Hitmonchan-style Attack lower than Defense", () => {
    expect(
      matchesRelativePhysicalStats("ATTACK_LT_DEFENSE", { attack: 40, defense: 55 }),
    ).toBe(true);
    expect(
      matchesRelativePhysicalStats("ATTACK_LT_DEFENSE", { attack: 55, defense: 40 }),
    ).toBe(false);
  });

  it("selects Hitmontop-style equal Attack and Defense", () => {
    expect(
      matchesRelativePhysicalStats("ATTACK_EQ_DEFENSE", { attack: 48, defense: 48 }),
    ).toBe(true);
    expect(
      matchesRelativePhysicalStats("ATTACK_EQ_DEFENSE", { attack: 48, defense: 47 }),
    ).toBe(false);
  });

  it("keeps ordinary level evolutions unconditional", () => {
    expect(matchesRelativePhysicalStats(undefined, { attack: 1, defense: 999 })).toBe(true);
  });
});
