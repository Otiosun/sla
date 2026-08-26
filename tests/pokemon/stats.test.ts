import { describe, expect, it } from "vitest";
import {
  adjustCurrentHpAfterStatChange,
  calculatePokemonStats,
} from "../../src/modules/pokemon/stats.js";

const base = { hp: 39, attack: 52, defense: 43, spAttack: 60, spDefense: 50, speed: 65 };
const ivs = { hp: 15, attack: 15, defense: 15, spAttack: 15, spDefense: 15, speed: 15 };
const nature = { increasedStat: null, decreasedStat: null } as const;

describe("Pokemon progression stats", () => {
  it("recalculates stats through the same owner used by Battle", () => {
    const level5 = calculatePokemonStats({
      baseStats: base,
      ivs,
      level: 5,
      nature,
      ivEnabled: true,
      natureEnabled: true,
    });
    const level6 = calculatePokemonStats({
      baseStats: base,
      ivs,
      level: 6,
      nature,
      ivEnabled: true,
      natureEnabled: true,
    });
    expect(level6.hp).toBeGreaterThan(level5.hp);
    expect(level6.speed).toBeGreaterThanOrEqual(level5.speed);
  });

  it("adds max-HP growth without reviving a fainted Pokemon", () => {
    expect(adjustCurrentHpAfterStatChange({ currentHp: 10, oldMaxHp: 20, newMaxHp: 23 })).toBe(13);
    expect(adjustCurrentHpAfterStatChange({ currentHp: 0, oldMaxHp: 20, newMaxHp: 23 })).toBe(0);
  });
});
