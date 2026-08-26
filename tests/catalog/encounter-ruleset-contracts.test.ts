import { describe, expect, it } from "vitest";
import { RulesetConfigSchema } from "../../src/modules/catalog/contracts.js";

const LEGACY_RULESET = {
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
  },
  capture: {
    model: "POKEMON_INSPIRED_V1",
    maxProbabilityBasisPoints: 9_500,
  },
  defeat: { automaticMoneyLoss: false },
  narrative: { authority: "N0_FLAVOR_ONLY" },
} as const;

describe("encounter ruleset catalog contract", () => {
  it("keeps historical v1 rulesets valid when encounter policy is absent", () => {
    expect(RulesetConfigSchema.safeParse(LEGACY_RULESET).success).toBe(true);
  });

  it("accepts an explicit allowlisted encounter and capture policy", () => {
    const result = RulesetConfigSchema.safeParse({
      ...LEGACY_RULESET,
      encounter: { expirationSeconds: 900 },
      capture: {
        ...LEGACY_RULESET.capture,
        allowedEncounterStates: ["IN_BATTLE"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unsafe or unknown encounter policy values", () => {
    const badExpiration = RulesetConfigSchema.safeParse({
      ...LEGACY_RULESET,
      encounter: { expirationSeconds: 5 },
    });
    expect(badExpiration.success).toBe(false);

    const badCaptureState = RulesetConfigSchema.safeParse({
      ...LEGACY_RULESET,
      capture: {
        ...LEGACY_RULESET.capture,
        allowedEncounterStates: ["CREATED"],
      },
    });
    expect(badCaptureState.success).toBe(false);

    const executablePolicy = RulesetConfigSchema.safeParse({
      ...LEGACY_RULESET,
      encounter: { expirationSeconds: 900, script: "return true" },
    });
    expect(executablePolicy.success).toBe(false);
  });
});
