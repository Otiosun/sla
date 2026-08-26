import { describe, expect, it } from "vitest";
import type { RulesetSnapshot } from "../../src/modules/catalog/contracts.js";
import { normalizeBattleRules } from "../../src/modules/battle/rules.js";
import { IDS } from "./fixtures.js";

function snapshot(overrides: Record<string, unknown> = {}): RulesetSnapshot {
  return {
    id: IDS.ruleset,
    status: "PUBLISHED",
    config: {
      schemaVersion: 1,
      battle: {
        statModel: "SIX_STATS",
        physicalSpecialByMove: true,
        ivEnabled: true,
        evEnabled: false,
        natureEnabled: true,
        maxMoves: 4,
        ppEnabled: true,
        criticalMultiplierBasisPoints: 15_000,
        accuracyEvasionEnabled: true,
        ...overrides,
      },
      capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 9_500 },
      defeat: { automaticMoneyLoss: false },
      narrative: { authority: "N0_FLAVOR_ONLY" },
    },
    typeMatchups: [],
  };
}

describe("Battle Engine ruleset normalization", () => {
  it("preserves historical rulesets through explicit v1 defaults", () => {
    const result = normalizeBattleRules(snapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stabMultiplierBasisPoints).toBe(15_000);
    expect(result.value.damageRandomMinBasisPoints).toBe(8_500);
    expect(result.value.damageRandomMaxBasisPoints).toBe(10_000);
    expect(result.value.switchConsumesTurn).toBe(true);
  });

  it("accepts explicit compatible battle policies", () => {
    const result = normalizeBattleRules(
      snapshot({
        stabMultiplierBasisPoints: 16_000,
        damageRandomMinBasisPoints: 9_000,
        damageRandomMaxBasisPoints: 9_500,
        switchConsumesTurn: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stabMultiplierBasisPoints).toBe(16_000);
    expect(result.value.damageRandomMinBasisPoints).toBe(9_000);
  });

  it("fails closed on inverted ranges or unsupported free switching", () => {
    expect(
      normalizeBattleRules(
        snapshot({ damageRandomMinBasisPoints: 10_000, damageRandomMaxBasisPoints: 9_000 }),
      ).ok,
    ).toBe(false);
    expect(normalizeBattleRules(snapshot({ switchConsumesTurn: false })).ok).toBe(false);
  });
});
