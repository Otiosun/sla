import { describe, expect, it } from "vitest";
import { POKEMON_CENTER_HEALABLE_CONDITIONS } from "../../src/modules/world-services/healing-service.js";

describe("Pokemon Center healing policy", () => {
  it("clears all canonical major battle statuses, including bad poison", () => {
    expect(POKEMON_CENTER_HEALABLE_CONDITIONS).toEqual([
      "BURN",
      "POISON",
      "BAD_POISON",
      "PARALYSIS",
      "SLEEP",
      "FREEZE",
    ]);
    expect(POKEMON_CENTER_HEALABLE_CONDITIONS).not.toContain("CURSE");
    expect(POKEMON_CENTER_HEALABLE_CONDITIONS).not.toContain("EVOLUTION_READY");
  });
});
