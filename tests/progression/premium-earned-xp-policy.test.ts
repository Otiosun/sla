import { describe, expect, it } from "vitest";
import {
  eligibleEarnedTrainerAdjustment,
  multiplyEarnedXp,
} from "../../src/modules/progression/rules.js";

describe("Premium 2XP shared earned-reward policy", () => {
  it("doubles earned Pokemon/trainer XP once, with overflow protection", () => {
    expect(multiplyEarnedXp(0, 2)).toBe(0);
    expect(multiplyEarnedXp(45, 1)).toBe(45);
    expect(multiplyEarnedXp(45, 2)).toBe(90);
    expect(() => multiplyEarnedXp(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
    expect(() => multiplyEarnedXp(-1, 2)).toThrow(RangeError);
    expect(() => multiplyEarnedXp(10, 3 as 1 | 2)).toThrow(RangeError);
  });

  it("scales legitimate positive system XP and explicit admin gifts, never corrections", () => {
    expect(eligibleEarnedTrainerAdjustment({ delta: 25, actorType: "SYSTEM", sourceType: "MISSION" })).toBe(true);
    expect(eligibleEarnedTrainerAdjustment({ delta: 25, actorType: "SYSTEM", sourceType: "EVENT" })).toBe(true);
    expect(eligibleEarnedTrainerAdjustment({ delta: 25, actorType: "ADMIN", sourceType: "ADMIN_REWARD" })).toBe(true);
    expect(eligibleEarnedTrainerAdjustment({ delta: 25, actorType: "ADMIN", sourceType: "ADMIN_CORRECTION" })).toBe(false);
    expect(eligibleEarnedTrainerAdjustment({ delta: 25, actorType: "ADMIN", sourceType: "ADMIN_ADJUSTMENT" })).toBe(false);
    expect(eligibleEarnedTrainerAdjustment({ delta: -25, actorType: "SYSTEM", sourceType: "MISSION" })).toBe(false);
  });
});
