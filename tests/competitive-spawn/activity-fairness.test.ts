import { describe, expect, it } from "vitest";
import {
  competitiveActivityMonotoneTargetMilli,
  competitiveActivityTargetMilli,
} from "../../src/modules/competitive-spawn/activity.js";

describe("competitive spawn activity target fairness", () => {
  it("never raises the target while the same cycle is active", () => {
    const roll = 9_999;

    const solo = competitiveActivityMonotoneTargetMilli({
      previousTargetMilli: null,
      activeParticipants: 1,
      roll,
      resetCycle: false,
    });
    expect(solo).toBe(competitiveActivityTargetMilli(1, roll));

    const crowded = competitiveActivityMonotoneTargetMilli({
      previousTargetMilli: solo,
      activeParticipants: 6,
      roll,
      resetCycle: false,
    });
    expect(crowded).toBeLessThanOrEqual(solo);
    expect(crowded).toBe(competitiveActivityTargetMilli(6, roll));

    const backToSolo = competitiveActivityMonotoneTargetMilli({
      previousTargetMilli: crowded,
      activeParticipants: 1,
      roll,
      resetCycle: false,
    });
    expect(backToSolo).toBe(crowded);
  });

  it("may roll a higher target only after a true cycle reset", () => {
    const roll = 9_999;
    const previous = competitiveActivityTargetMilli(6, roll);

    const reset = competitiveActivityMonotoneTargetMilli({
      previousTargetMilli: previous,
      activeParticipants: 1,
      roll,
      resetCycle: true,
    });

    expect(reset).toBe(competitiveActivityTargetMilli(1, roll));
    expect(reset).toBeGreaterThan(previous);
  });
});
