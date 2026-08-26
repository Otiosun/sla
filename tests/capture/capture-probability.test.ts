import { describe, expect, it } from "vitest";
import type { CaptureProbabilityInput } from "../../src/modules/capture/contracts.js";
import { captureProbability } from "../../src/modules/capture/probability.js";

function input(overrides: Partial<CaptureProbabilityInput> = {}): CaptureProbabilityInput {
  return {
    catchRate: 120,
    currentHp: 50,
    maxHp: 100,
    ballMultiplierBasisPoints: 10_000,
    status: null,
    explicitModifierBasisPoints: [],
    ruleset: {
      model: "POKEMON_INSPIRED_V1",
      maxProbabilityBasisPoints: 9_500,
    },
    ...overrides,
  };
}

describe("captureProbability", () => {
  it("keeps the canonical basis-point projection explainable", () => {
    const result = captureProbability(input());

    expect(result).toEqual({
      probabilityBasisPoints: 3_136,
      breakdown: {
        model: "POKEMON_INSPIRED_V1",
        catchRate: 120,
        catchRateBasisPoints: 4_705,
        currentHp: 50,
        maxHp: 100,
        hpFactorBasisPoints: 6_666,
        ballMultiplierBasisPoints: 10_000,
        status: null,
        statusMultiplierBasisPoints: 10_000,
        explicitModifierBasisPoints: [],
        rawProbabilityBasisPoints: 3_136,
        maxProbabilityBasisPoints: 9_500,
        finalProbabilityBasisPoints: 3_136,
      },
    });
  });

  it("increases chance when HP falls and never leaves the ruleset clamp", () => {
    let previous = -1;
    for (let hp = 100; hp >= 1; hp -= 1) {
      const probability = captureProbability(
        input({ catchRate: 255, currentHp: hp, maxHp: 100 }),
      ).probabilityBasisPoints;
      expect(probability).toBeGreaterThanOrEqual(previous);
      expect(probability).toBeLessThanOrEqual(9_500);
      previous = probability;
    }
  });

  it("applies status, Ball and explicit modifiers mechanically", () => {
    const baseline = captureProbability(input()).probabilityBasisPoints;
    const paralysis = captureProbability(input({ status: "PARALYSIS" })).probabilityBasisPoints;
    const sleep = captureProbability(input({ status: "SLEEP" })).probabilityBasisPoints;
    const betterBall = captureProbability(
      input({ ballMultiplierBasisPoints: 15_000 }),
    ).probabilityBasisPoints;
    const explicit = captureProbability(
      input({ explicitModifierBasisPoints: [12_500] }),
    ).probabilityBasisPoints;

    expect(paralysis).toBeGreaterThan(baseline);
    expect(sleep).toBeGreaterThan(paralysis);
    expect(betterBall).toBeGreaterThan(baseline);
    expect(explicit).toBeGreaterThan(baseline);
  });

  it("canonicalizes explicit modifier order before integer rounding", () => {
    const forward = captureProbability(input({ explicitModifierBasisPoints: [12_345, 17_891] }));
    const reversed = captureProbability(input({ explicitModifierBasisPoints: [17_891, 12_345] }));

    expect(forward).toEqual(reversed);
    expect(forward.breakdown.explicitModifierBasisPoints).toEqual([12_345, 17_891]);
  });

  it("returns zero for catchRate zero regardless of bonuses", () => {
    expect(
      captureProbability(
        input({
          catchRate: 0,
          currentHp: 1,
          status: "SLEEP",
          ballMultiplierBasisPoints: 100_000,
          explicitModifierBasisPoints: [100_000, 100_000],
        }),
      ).probabilityBasisPoints,
    ).toBe(0);
  });

  it("caps a mechanically huge chance at the pinned ruleset maximum", () => {
    const result = captureProbability(
      input({
        catchRate: 255,
        currentHp: 1,
        status: "SLEEP",
        ballMultiplierBasisPoints: 100_000,
        explicitModifierBasisPoints: [100_000],
        ruleset: {
          model: "POKEMON_INSPIRED_V1",
          maxProbabilityBasisPoints: 8_000,
        },
      }),
    );

    expect(result.probabilityBasisPoints).toBe(8_000);
    expect(result.breakdown.finalProbabilityBasisPoints).toBe(8_000);
    expect(result.breakdown.rawProbabilityBasisPoints).toBe(10_000);
  });

  it("rejects impossible HP state instead of silently normalizing it", () => {
    expect(() => captureProbability(input({ currentHp: 101, maxHp: 100 }))).toThrow(RangeError);
  });
});
