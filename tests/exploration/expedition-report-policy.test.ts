import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ExpeditionReportRewardPolicy,
  reportRewards,
} from "../../src/modules/exploration/expedition-report-policy.js";

const currencyId = randomUUID(),
  itemId = randomUUID(),
  key = Buffer.alloc(32, 0x61);
const money = { kind: "MONEY" as const, currencyId, amount: "300" };
const item = { kind: "ITEM" as const, itemId, quantity: "1" };
const points = { kind: "TRAINER_POINTS" as const, amount: 25 };
const config = {
  base: [money],
  normal: [{ weight: 10000, reward: item }],
  highlight: [{ weight: 10000, reward: points }],
};
describe("published external report reward policy", () => {
  it("uses authored amounts and exactly one normal draw, with one extra only for highlight", () => {
    expect(reportRewards(config, "NORMAL", key, "report:release")).toEqual([money, item]);
    expect(reportRewards(config, "HIGHLIGHT", key, "report:release")).toEqual([
      money,
      item,
      points,
    ]);
    expect(reportRewards(config, "HIGHLIGHT", key, "report:release")).toEqual(
      reportRewards(config, "HIGHLIGHT", key, "report:release"),
    );
  });
  it("provides no default odds, prize, currency or item", () => {
    expect(() => reportRewards({}, "NORMAL", key, "report:release")).toThrow();
    expect(
      ExpeditionReportRewardPolicy.safeParse({
        ...config,
        normal: [{ weight: 9999, reward: item }],
      }).success,
    ).toBe(false);
  });
  it("retains BIGINT precision and rejects overflow before grants", () => {
    const maximum = { ...money, amount: "9223372036854775807" };
    expect(
      reportRewards({ ...config, base: [maximum] }, "NORMAL", key, "report:release")[0],
    ).toEqual(maximum);
    expect(() =>
      reportRewards(
        { ...config, base: [{ ...money, amount: "9223372036854775808" }] },
        "NORMAL",
        key,
        "report:release",
      ),
    ).toThrow();
  });
  it("does not admit mechanical Pokemon XP, a client-selected roll or extra policy fields", () => {
    expect(ExpeditionReportRewardPolicy.safeParse({ ...config, roll: 7 }).success).toBe(false);
    expect(
      ExpeditionReportRewardPolicy.safeParse({
        ...config,
        base: [{ kind: "POKEMON_XP", amount: 100 }],
      }).success,
    ).toBe(false);
    expect(() => reportRewards(config, "NORMAL", Buffer.alloc(1), "report:release")).toThrow();
  });
});
