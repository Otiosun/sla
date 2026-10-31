import { describe, expect, it } from "vitest";
import {
  auditHistoricalMove,
  auditOverdueLevelEvolution,
} from "../../src/modules/progression/recovery-audit.js";

const ivysaur = { targetFormId: "ivysaur-form", requiredLevel: 16, relativePhysicalStats: null };

describe("historical progression repair safety", () => {
  it("flags level 20 and 100 Pokémon who missed automatic evolution", () => {
    for (const level of [20, 100]) {
      expect(
        auditOverdueLevelEvolution({ currentLevel: level, candidates: [ivysaur] }),
      ).toMatchObject({ state: "ELIGIBLE_TO_REVIEW", candidateTargetFormId: "ivysaur-form" });
    }
  });

  it("does not propose evolution before the level threshold", () => {
    expect(auditOverdueLevelEvolution({ currentLevel: 15, candidates: [ivysaur] }).state).toBe(
      "NO_ELIGIBLE_RULE",
    );
  });

  it("does not evolve when stats are missing or two destinations qualify", () => {
    const relative = {
      targetFormId: "attack-form",
      requiredLevel: 20,
      relativePhysicalStats: "ATTACK_GT_DEFENSE" as const,
    };
    expect(auditOverdueLevelEvolution({ currentLevel: 25, candidates: [relative] }).state).toBe(
      "NEEDS_STAT_REVIEW",
    );
    expect(
      auditOverdueLevelEvolution({
        currentLevel: 25,
        currentAttack: 60,
        currentDefense: 40,
        candidates: [relative],
      }).state,
    ).toBe("ELIGIBLE_TO_REVIEW");
    expect(
      auditOverdueLevelEvolution({
        currentLevel: 25,
        candidates: [ivysaur, { ...ivysaur, targetFormId: "another-form" }],
      }).state,
    ).toBe("AMBIGUOUS");
  });

  it("does not restore explicitly skipped or previously learned moves", () => {
    expect(
      auditHistoricalMove({
        moveId: "growl",
        currentMoveIds: ["growl"],
        hasResolvedOrSkippedHistory: false,
      }).state,
    ).toBe("ALREADY_KNOWN");
    expect(
      auditHistoricalMove({
        moveId: "growl",
        currentMoveIds: ["tackle"],
        hasResolvedOrSkippedHistory: true,
      }).state,
    ).toBe("RESOLVED_OR_SKIPPED");
    expect(
      auditHistoricalMove({
        moveId: "growl",
        currentMoveIds: ["tackle"],
        hasResolvedOrSkippedHistory: false,
      }).state,
    ).toBe("OFFER_FOR_REVIEW");
  });
});
