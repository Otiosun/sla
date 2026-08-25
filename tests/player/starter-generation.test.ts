import { describe, expect, it } from "vitest";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { onboardingStateMachine } from "../../src/modules/player/onboarding-state.js";
import { generateStarter } from "../../src/modules/player/starter-generation.js";
import type { StarterBuild } from "../../src/modules/player/contracts.js";

const build: StarterBuild = {
  contentReleaseId: "release",
  rulesetId: "ruleset",
  regionId: "region",
  formId: "form",
  starterLevel: 5,
  baseHp: 45,
  abilityIds: ["ability-a", "ability-b"],
  natureIds: ["nature-a", "nature-b"],
  moves: [
    { moveId: "move-start-a", maxPp: 35, learnMethod: "START", learnLevel: null },
    { moveId: "move-start-b", maxPp: 40, learnMethod: "START", learnLevel: null },
    { moveId: "move-level-5", maxPp: 25, learnMethod: "LEVEL", learnLevel: 5 },
    { moveId: "move-level-6", maxPp: 20, learnMethod: "LEVEL", learnLevel: 6 },
    { moveId: "move-extra", maxPp: 15, learnMethod: "START", learnLevel: null },
  ],
};

describe("player onboarding state and starter generation", () => {
  it("allows only the explicit onboarding path", () => {
    expect(onboardingStateMachine.transition("NEW", "PROFILE_CREATED")).toEqual({
      ok: true,
      value: "PROFILE_CREATED",
    });
    expect(onboardingStateMachine.transition("PROFILE_CREATED", "STARTER_PENDING")).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(onboardingStateMachine.transition("STARTER_GRANTED", "COMPLETE")).toEqual({
      ok: true,
      value: "COMPLETE",
    });
  });

  it("generates a deterministic legal starter with bounded IVs and at most four moves", () => {
    const first = generateStarter(build, new DeterministicRandomSource(12345));
    const replay = generateStarter(build, new DeterministicRandomSource(12345));
    expect(replay).toEqual(first);
    expect(first.level).toBe(5);
    expect(first.currentHp).toBeGreaterThan(0);
    expect(Object.values(first.ivs).every((value) => value >= 0 && value <= 31)).toBe(true);
    expect(build.abilityIds).toContain(first.abilityId);
    expect(build.natureIds).toContain(first.natureId);
    expect(first.moves.length).toBeLessThanOrEqual(4);
    expect(first.moves.map((move) => move.moveId)).not.toContain("move-level-6");
    expect(first.moves.every((move) => move.ppCurrent > 0)).toBe(true);
  });

  it("fails closed when starter content cannot produce an ability, nature, or move", () => {
    expect(() =>
      generateStarter({ ...build, abilityIds: [] }, new DeterministicRandomSource(1)),
    ).toThrow("ability");
    expect(() =>
      generateStarter({ ...build, natureIds: [] }, new DeterministicRandomSource(1)),
    ).toThrow("nature");
    expect(() =>
      generateStarter({ ...build, moves: [] }, new DeterministicRandomSource(1)),
    ).toThrow("eligible move");
  });
});
