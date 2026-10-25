import { describe, expect, it, vi } from "vitest";
import {
  EXPEDITION_REPORT_BASE_MONEY,
  proposeExpeditionReportSettlement,
} from "../../src/modules/exploration/expedition-report-reward-policy.js";

const PLAYER = "00000000-0000-4000-8000-000000000013";
const EXPEDITION = "00000000-0000-4000-8000-000000000031";

function ended(endReason: "VOLUNTARY" | "CLOCK" | "BLACKOUT" | "CANCELLED" = "VOLUNTARY") {
  return {
    expeditionId: EXPEDITION,
    playerId: PLAYER,
    phase: "ENDED" as const,
    endReason,
    consumedWeekKey: endReason === "CANCELLED" ? null : "2026-10-19",
  };
}

describe("V1.6 report settlement proposal (pure, no payout)", () => {
  it("reserves the approved fixed reward but never issues it from the policy function", () => {
    const result = proposeExpeditionReportSettlement({
      expedition: ended(),
      approvalKind: "NORMAL",
      nextInt: () => 45,
    });
    expect(EXPEDITION_REPORT_BASE_MONEY).toBe(300);
    expect(result).toMatchObject({
      ok: true,
      value: {
        expeditionId: EXPEDITION,
        playerId: PLAYER,
        approvalKind: "NORMAL",
        baseMoney: 300,
        totalMoney: 300,
        pokeBalls: 1,
        potions: 0,
        trainerProgress: 0,
        highlightBonus: null,
      },
    });
    if (!result.ok || result.value === null) return;
    expect(Object.keys(result.value).sort()).toEqual([
      "approvalKind",
      "baseMoney",
      "expeditionId",
      "highlightBonus",
      "normalBonus",
      "playerId",
      "pokeBalls",
      "potions",
      "totalMoney",
      "trainerProgress",
    ]);
  });

  it.each([
    { roll: 0, kind: "MONEY", quantity: 200, money: 500 },
    { roll: 44, kind: "MONEY", quantity: 200, money: 500 },
    { roll: 45, kind: "POKE_BALL", quantity: 1, money: 300 },
    { roll: 74, kind: "POKE_BALL", quantity: 1, money: 300 },
    { roll: 75, kind: "POTION", quantity: 1, money: 300 },
    { roll: 89, kind: "POTION", quantity: 1, money: 300 },
    { roll: 90, kind: "TRAINER_PROGRESS", quantity: 50, money: 300 },
    { roll: 99, kind: "TRAINER_PROGRESS", quantity: 50, money: 300 },
  ])("uses one normal-report RNG draw for boundary $roll", ({ roll, kind, quantity, money }) => {
    const rng = vi.fn(() => roll);
    const result = proposeExpeditionReportSettlement({
      expedition: ended("CLOCK"),
      approvalKind: "NORMAL",
      nextInt: rng,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        totalMoney: money,
        normalBonus: { kind, quantity },
        highlightBonus: null,
      },
    });
    expect(rng).toHaveBeenCalledExactlyOnceWith(100);
  });

  it.each([
    { roll: 0, kind: "MONEY", quantity: 100 },
    { roll: 59, kind: "MONEY", quantity: 100 },
    { roll: 60, kind: "POKE_BALL", quantity: 1 },
    { roll: 84, kind: "POKE_BALL", quantity: 1 },
    { roll: 85, kind: "POTION", quantity: 1 },
    { roll: 94, kind: "POTION", quantity: 1 },
    { roll: 95, kind: "TRAINER_PROGRESS", quantity: 25 },
    { roll: 99, kind: "TRAINER_PROGRESS", quantity: 25 },
  ])("adds exactly one independent highlight roll for $roll", ({ roll, kind, quantity }) => {
    const rng = vi.fn()
      .mockReturnValueOnce(45)
      .mockReturnValueOnce(roll);
    const result = proposeExpeditionReportSettlement({
      expedition: ended(),
      approvalKind: "HIGHLIGHT",
      nextInt: rng,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        baseMoney: 300,
        normalBonus: { kind: "POKE_BALL", quantity: 1 },
        highlightBonus: { kind, quantity },
      },
    });
    expect(rng).toHaveBeenCalledTimes(2);
    expect(rng).toHaveBeenNthCalledWith(1, 100);
    expect(rng).toHaveBeenNthCalledWith(2, 100);
  });

  it("does not let a rejected report create a payout or consume random numbers", () => {
    const rng = vi.fn();
    const result = proposeExpeditionReportSettlement({
      expedition: ended(),
      approvalKind: "REJECTED",
      nextInt: rng,
    });
    expect(result).toEqual({ ok: true, value: null });
    expect(rng).not.toHaveBeenCalled();
  });

  it.each(["BLACKOUT", "CANCELLED"] as const)(
    "refuses payout after %s without generating randomness",
    (reason) => {
      const rng = vi.fn();
      const result = proposeExpeditionReportSettlement({
        expedition: ended(reason),
        approvalKind: "HIGHLIGHT",
        nextInt: rng,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
      expect(rng).not.toHaveBeenCalled();
    },
  );

  it("refuses an active or incomplete expedition, even if staff tries to approve it", () => {
    for (const phase of ["PREPARING", "ACTIVE"] as const) {
      const rng = vi.fn();
      const result = proposeExpeditionReportSettlement({
        expedition: { ...ended(), phase, endReason: null },
        approvalKind: "NORMAL",
        nextInt: rng,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
      expect(rng).not.toHaveBeenCalled();
    }
  });

  it("requires a persisted weekly debit before any settlement proposal", () => {
    const rng = vi.fn();
    expect(
      proposeExpeditionReportSettlement({
        expedition: { ...ended(), consumedWeekKey: null },
        approvalKind: "NORMAL",
        nextInt: rng,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(rng).not.toHaveBeenCalled();
  });

  it.each([-1, 100, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid normal RNG output %s",
    (roll) => {
      const rng = vi.fn(() => roll);
      const result = proposeExpeditionReportSettlement({
        expedition: ended(),
        approvalKind: "NORMAL",
        nextInt: rng,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
      expect(rng).toHaveBeenCalledTimes(1);
    },
  );

  it.each([-1, 100, 2.5, Number.NaN])("rejects invalid highlight RNG output %s", (roll) => {
    const rng = vi.fn().mockReturnValueOnce(45).mockReturnValueOnce(roll);
    const result = proposeExpeditionReportSettlement({
      expedition: ended(),
      approvalKind: "HIGHLIGHT",
      nextInt: rng,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    expect(rng).toHaveBeenCalledTimes(2);
  });

  it("keeps the exact stated probability bands instead of an admin-selected reward", () => {
    const normalCounts = { MONEY: 0, POKE_BALL: 0, POTION: 0, TRAINER_PROGRESS: 0 };
    const highlightCounts = { MONEY: 0, POKE_BALL: 0, POTION: 0, TRAINER_PROGRESS: 0 };
    for (let roll = 0; roll < 100; roll++) {
      const normal = proposeExpeditionReportSettlement({
        expedition: ended(),
        approvalKind: "NORMAL",
        nextInt: () => roll,
      });
      const highlight = proposeExpeditionReportSettlement({
        expedition: ended(),
        approvalKind: "HIGHLIGHT",
        nextInt: vi.fn().mockReturnValueOnce(45).mockReturnValueOnce(roll),
      });
      if (!normal.ok || normal.value === null || !highlight.ok || highlight.value === null) {
        throw new Error("Expected legitimate report outcomes");
      }
      normalCounts[normal.value.normalBonus.kind] += 1;
      const highlightKind = highlight.value.highlightBonus?.kind;
      if (highlightKind === undefined) throw new Error("Highlight must include an extra draw");
      highlightCounts[highlightKind] += 1;
    }
    expect(normalCounts).toEqual({ MONEY: 45, POKE_BALL: 30, POTION: 15, TRAINER_PROGRESS: 10 });
    expect(highlightCounts).toEqual({ MONEY: 60, POKE_BALL: 25, POTION: 10, TRAINER_PROGRESS: 5 });
  });

  it("preserves the approved expectation values without promising XP or items from battles", () => {
    const expectedMoney = 300 + 200 * 0.45;
    const expectedBall = 1 * 0.30;
    const expectedPotion = 1 * 0.15;
    const expectedProgress = 50 * 0.10;
    expect(expectedMoney).toBe(390);
    expect(expectedBall).toBe(0.30);
    expect(expectedPotion).toBe(0.15);
    expect(expectedProgress).toBe(5);
    const result = proposeExpeditionReportSettlement({
      expedition: ended(),
      approvalKind: "HIGHLIGHT",
      nextInt: vi.fn().mockReturnValueOnce(45).mockReturnValueOnce(95),
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value !== null) {
      expect("pokemonXp" in result.value).toBe(false);
      expect("capture" in result.value).toBe(false);
    }
  });
});
