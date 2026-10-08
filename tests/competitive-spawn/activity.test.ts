import { describe, expect, it } from "vitest";
import {
  competitiveActivityBand,
  competitiveActivityBaseWeightMilli,
  competitiveActivityCreditMilli,
  competitiveActivityDecayedProgressMilli,
  competitiveActivityTargetMilli,
} from "../../src/modules/competitive-spawn/activity.js";

const message = (
  text: string | null,
  mediaKinds: readonly ("IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "STICKER" | "OTHER")[] = [],
) => ({
  text,
  mediaRefs: mediaKinds.map((kind, index) => ({
    providerMediaId: `m-${index}`,
    kind,
    mimeType: null,
    fileName: null,
  })),
});

describe("competitive spawn activity", () => {
  it("keeps solo play viable while making larger active groups reach a lower target band", () => {
    expect(competitiveActivityBand(1)).toEqual({ minPoints: 11, maxPoints: 20 });
    expect(competitiveActivityBand(2)).toEqual({ minPoints: 9, maxPoints: 18 });
    expect(competitiveActivityBand(4)).toEqual({ minPoints: 8, maxPoints: 17 });
    expect(competitiveActivityBand(8)).toEqual({ minPoints: 7, maxPoints: 16 });
    expect(competitiveActivityTargetMilli(1, 0)).toBe(11_000);
    expect(competitiveActivityTargetMilli(1, 9_999)).toBe(20_000);
    expect(competitiveActivityTargetMilli(8, 0)).toBe(7_000);
    expect(competitiveActivityTargetMilli(8, 9_999)).toBe(16_000);
  });

  it("counts ordinary conversation most, media meaningfully, commands less, and catch aliases zero", () => {
    expect(competitiveActivityBaseWeightMilli(message("conversa normal"))).toBe(1_000);
    expect(competitiveActivityBaseWeightMilli(message(null, ["IMAGE"]))).toBe(800);
    expect(competitiveActivityBaseWeightMilli(message(null, ["AUDIO"]))).toBe(700);
    expect(competitiveActivityBaseWeightMilli(message(null, ["STICKER"]))).toBe(250);
    expect(competitiveActivityBaseWeightMilli(message("/pc"))).toBe(400);
    expect(competitiveActivityBaseWeightMilli(message("/c pikachu"))).toBe(0);
    expect(competitiveActivityBaseWeightMilli(message("/catch pikachu"))).toBe(0);
    expect(competitiveActivityBaseWeightMilli(message("/capturar pikachu"))).toBe(0);
  });

  it("penalizes machine-like bursts harder in multiplayer without making solo rapid play impossible", () => {
    const solo = competitiveActivityCreditMilli({
      baseWeightMilli: 1_000,
      activeParticipants: 1,
      sinceSameSenderMs: 1_000,
      repeatedRecently: false,
      senderStreak: 5,
    });
    const multiplayer = competitiveActivityCreditMilli({
      baseWeightMilli: 1_000,
      activeParticipants: 3,
      sinceSameSenderMs: 1_000,
      repeatedRecently: false,
      senderStreak: 5,
    });
    expect(solo).toBe(450);
    expect(multiplayer).toBe(45);
    expect(solo).toBeGreaterThan(multiplayer);
  });

  it("heavily discounts repeated content and decays stale progress", () => {
    expect(
      competitiveActivityCreditMilli({
        baseWeightMilli: 1_000,
        activeParticipants: 1,
        sinceSameSenderMs: 10_000,
        repeatedRecently: true,
        senderStreak: 1,
      }),
    ).toBe(150);

    const now = new Date("2026-10-08T12:00:00Z");
    expect(
      competitiveActivityDecayedProgressMilli(12_000, new Date("2026-10-08T11:40:00Z"), now),
    ).toEqual({ progressMilli: 6_000, resetCycle: false });
    expect(
      competitiveActivityDecayedProgressMilli(12_000, new Date("2026-10-08T11:20:00Z"), now),
    ).toEqual({ progressMilli: 0, resetCycle: true });
  });
});
