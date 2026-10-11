import { describe, expect, it } from "vitest";
import {
  competitiveSpawnBaseRewardKind,
  competitiveSpawnMoneyAmount,
} from "../../src/modules/competitive-spawn/reward.js";

describe("competitive spawn reward policy", () => {
  it("keeps the 45/35/20 base reward split", () => {
    expect(competitiveSpawnBaseRewardKind(0)).toBe("MONEY");
    expect(competitiveSpawnBaseRewardKind(4_499)).toBe("MONEY");
    expect(competitiveSpawnBaseRewardKind(4_500)).toBe("ITEM");
    expect(competitiveSpawnBaseRewardKind(7_999)).toBe("ITEM");
    expect(competitiveSpawnBaseRewardKind(8_000)).toBe("PROGRESSION");
    expect(competitiveSpawnBaseRewardKind(9_999)).toBe("PROGRESSION");
  });

  it("scales money inversely with catch rate around the ~400 target", () => {
    expect(competitiveSpawnMoneyAmount(255)).toBe(250);
    expect(competitiveSpawnMoneyAmount(190)).toBe(250);
    expect(competitiveSpawnMoneyAmount(189)).toBe(325);
    expect(competitiveSpawnMoneyAmount(120)).toBe(325);
    expect(competitiveSpawnMoneyAmount(119)).toBe(450);
    expect(competitiveSpawnMoneyAmount(60)).toBe(450);
    expect(competitiveSpawnMoneyAmount(59)).toBe(650);
    expect(competitiveSpawnMoneyAmount(30)).toBe(650);
    expect(competitiveSpawnMoneyAmount(29)).toBe(900);
    expect(competitiveSpawnMoneyAmount(0)).toBe(900);
  });

  it("uses a conservative fallback when catch rate data is unavailable", () => {
    expect(competitiveSpawnMoneyAmount(null)).toBe(400);
    expect(competitiveSpawnMoneyAmount(Number.NaN)).toBe(400);
    expect(competitiveSpawnMoneyAmount(-1)).toBe(400);
  });
});
