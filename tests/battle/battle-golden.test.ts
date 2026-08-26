import { describe, expect, it } from "vitest";
import { computeDamage } from "../../src/modules/battle/damage.js";
import { CounterRandomSource } from "../../src/platform/rng/counter-rng.js";
import { IDS, TEST_RULES, playerCombatant, wildCombatant } from "./fixtures.js";

describe("Battle Engine v1 golden cases", () => {
  it("keeps the canonical Ember damage projection stable", () => {
    const attacker = playerCombatant();
    const defender = wildCombatant();
    defender.type1Id = IDS.grass;
    defender.type1Slug = "grass";
    defender.type2Id = null;
    defender.type2Slug = null;

    const ember = attacker.moves[1];
    if (ember === undefined) throw new Error("golden fixture is missing Ember");

    const result = computeDamage(
      attacker,
      defender,
      ember,
      TEST_RULES,
      new CounterRandomSource(Buffer.alloc(32, 0x42)),
    );

    expect(result).toEqual({
      damage: 32,
      critical: false,
      effectivenessBasisPoints: 20_000,
      stabApplied: true,
      randomBasisPoints: 10_000,
      abilityMultiplierBasisPoints: 10_000,
    });
  });
});
