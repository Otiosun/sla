import { describe, expect, it } from "vitest";
import { ProgressionRulesSchema } from "../../src/modules/catalog/contracts.js";
import {
  trainerLevelForPoints,
  trainerPointsRequiredForLevel,
} from "../../src/modules/progression/rules.js";

const pokemonRules = {
  xpCurve: "CUBIC_DELTA_V1",
  battleRewardModel: "BASE_EXP_LEVEL_DIV_7_V1",
  rewardRecipient: "ACTIVE_WINNER_V1",
  levelCap: 100,
  hpOnLevelUp: "ADD_MAX_HP_DELTA_IF_ALIVE_V1",
  fullMoveSlotsPolicy: "PENDING_CHOICE_V1",
  autoLevelEvolution: true,
} as const;

describe("canonical trainer progression", () => {
  it("grants exactly one trainer level per 100 Insígnias", () => {
    expect(trainerPointsRequiredForLevel(1, "LINEAR_100_V1")).toBe(0);
    expect(trainerPointsRequiredForLevel(2, "LINEAR_100_V1")).toBe(100);
    expect(trainerPointsRequiredForLevel(10, "LINEAR_100_V1")).toBe(900);
    expect(trainerPointsRequiredForLevel(100, "LINEAR_100_V1")).toBe(9_900);
    expect(trainerLevelForPoints(99, 100, "LINEAR_100_V1")).toBe(1);
    expect(trainerLevelForPoints(100, 100, "LINEAR_100_V1")).toBe(2);
    expect(trainerLevelForPoints(899, 100, "LINEAR_100_V1")).toBe(9);
    expect(trainerLevelForPoints(900, 100, "LINEAR_100_V1")).toBe(10);
  });

  it("preserves the historical quadratic curve for pinned rulesets", () => {
    expect(trainerPointsRequiredForLevel(10, "QUADRATIC_100_V1")).toBe(8_100);
    expect(trainerLevelForPoints(8_099, 100, "QUADRATIC_100_V1")).toBe(9);
    expect(trainerLevelForPoints(8_100, 100, "QUADRATIC_100_V1")).toBe(10);
  });

  it("binds the visible label to the versioned curve", () => {
    const common = {
      pokemon: pokemonRules,
      trainer: {
        levelCap: 100,
        pointsPerWonBattle: 100,
        unlocks: [{ level: 10, unlockKey: "tournament.eligible" }],
      },
    };
    expect(
      ProgressionRulesSchema.safeParse({
        ...common,
        trainer: {
          ...common.trainer,
          visiblePointsName: "Insígnia",
          levelCurve: "LINEAR_100_V1",
        },
      }).success,
    ).toBe(true);
    expect(
      ProgressionRulesSchema.safeParse({
        ...common,
        trainer: {
          ...common.trainer,
          visiblePointsName: "XP de Treinador",
          levelCurve: "QUADRATIC_100_V1",
        },
      }).success,
    ).toBe(true);
    expect(
      ProgressionRulesSchema.safeParse({
        ...common,
        trainer: {
          ...common.trainer,
          visiblePointsName: "Insígnia",
          levelCurve: "QUADRATIC_100_V1",
        },
      }).success,
    ).toBe(false);
  });
});
