import { describe, expect, it } from "vitest";
import {
  applyPokemonXp,
  battlePokemonXp,
  pokemonXpRequiredForNextLevel,
  trainerLevelForPoints,
  trainerPointsRequiredForLevel,
} from "../../src/modules/progression/rules.js";

describe("Phase 11 progression rules", () => {
  it("uses the documented cubic delta curve and crosses multiple levels deterministically", () => {
    expect(pokemonXpRequiredForNextLevel(1)).toBe(7);
    expect(pokemonXpRequiredForNextLevel(15)).toBe(721);
    const result = applyPokemonXp({ level: 5, xp: 0, gain: 1_000 });
    expect(result.afterLevel).toBeGreaterThan(5);
    expect(result.crossedLevels).toEqual(
      Array.from({ length: result.afterLevel - 5 }, (_, index) => 6 + index),
    );
    if (result.afterLevel < 100) {
      expect(result.afterXp).toBeLessThan(pokemonXpRequiredForNextLevel(result.afterLevel));
    }
  });

  it("never stores overflow XP beyond the level cap", () => {
    const result = applyPokemonXp({ level: 99, xp: 0, gain: 1_000_000 });
    expect(result.afterLevel).toBe(100);
    expect(result.afterXp).toBe(0);
    expect(result.discardedXp).toBeGreaterThan(0);
    expect(result.awardedXp + result.discardedXp).toBe(1_000_000);
  });

  it("calculates Pokemon-inspired battle XP with integer authority", () => {
    expect(battlePokemonXp(50, 2)).toBe(14);
    expect(battlePokemonXp(112, 5)).toBe(80);
  });

  it("uses versioned trainer thresholds suitable for explicit level 10 and 15 unlocks", () => {
    expect(trainerPointsRequiredForLevel(10)).toBe(8_100);
    expect(trainerPointsRequiredForLevel(15)).toBe(19_600);
    expect(trainerLevelForPoints(8_099)).toBe(9);
    expect(trainerLevelForPoints(8_100)).toBe(10);
    expect(trainerLevelForPoints(19_600)).toBe(15);
  });
});
