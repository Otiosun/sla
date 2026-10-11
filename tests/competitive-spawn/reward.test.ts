import { describe, expect, it } from "vitest";
import {
  competitiveSpawnBaseRewardKind,
  competitiveSpawnItemQuantity,
  competitiveSpawnMoneyAmount,
  competitiveSpawnPokemonBonusBasisPoints,
  competitiveSpawnPokemonBonusWon,
  competitiveSpawnProgressAmount,
} from "../../src/modules/competitive-spawn/reward.js";

describe("competitive spawn rewards", () => {
  it("keeps every base reward useful and bounded", () => {
    expect(competitiveSpawnBaseRewardKind(0)).toBe("MONEY");
    expect(competitiveSpawnBaseRewardKind(4_499)).toBe("MONEY");
    expect(competitiveSpawnBaseRewardKind(4_500)).toBe("ITEM");
    expect(competitiveSpawnBaseRewardKind(7_999)).toBe("ITEM");
    expect(competitiveSpawnBaseRewardKind(8_000)).toBe("PROGRESSION");
    expect(competitiveSpawnMoneyAmount(255)).toBe(250);
    expect(competitiveSpawnMoneyAmount(0)).toBe(900);
    expect(competitiveSpawnItemQuantity(0)).toBe(1);
    expect(competitiveSpawnItemQuantity(3)).toBe(4);
    expect(competitiveSpawnProgressAmount(0)).toBe(5);
    expect(competitiveSpawnProgressAmount(10)).toBe(15);
  });

  it("maps catch rate to the intended Pokemon bonus rarity bands", () => {
    expect(competitiveSpawnPokemonBonusBasisPoints(255)).toBe(1_800);
    expect(competitiveSpawnPokemonBonusBasisPoints(150)).toBe(800);
    expect(competitiveSpawnPokemonBonusBasisPoints(90)).toBe(800);
    expect(competitiveSpawnPokemonBonusBasisPoints(45)).toBe(400);
    expect(competitiveSpawnPokemonBonusBasisPoints(3)).toBe(150);
    expect(competitiveSpawnPokemonBonusBasisPoints(null)).toBe(600);
  });

  it("uses a strict basis-point roll", () => {
    expect(competitiveSpawnPokemonBonusWon(255, 1_799)).toBe(true);
    expect(competitiveSpawnPokemonBonusWon(255, 1_800)).toBe(false);
    expect(() => competitiveSpawnBaseRewardKind(10_000)).toThrow(RangeError);
  });
});
