import { describe, expect, it } from "vitest";
import {
  competitiveActivityMonotoneTargetMilli,
  competitiveActivityTargetMilli,
  competitiveIncenseTargetMilli,
} from "../../src/modules/competitive-spawn/activity.js";
import { parseCompetitiveSpawnAdminAction } from "../../src/modules/competitive-spawn/settings.js";

describe("competitive spawn canary controls", () => {
  it("parses force and restart-safe incense commands", () => {
    expect(parseCompetitiveSpawnAdminAction("/competitivo forçar")).toEqual({ kind: "FORCE" });
    expect(parseCompetitiveSpawnAdminAction("/competitivo forcar")).toEqual({ kind: "FORCE" });
    expect(parseCompetitiveSpawnAdminAction("/competitivo incenso")).toEqual({
      kind: "INCENSE_START",
      durationMs: 30 * 60_000,
    });
    expect(parseCompetitiveSpawnAdminAction("/competitivo incenso 45m")).toEqual({
      kind: "INCENSE_START",
      durationMs: 45 * 60_000,
    });
    expect(parseCompetitiveSpawnAdminAction("/competitivo incenso 2h")).toEqual({
      kind: "INCENSE_START",
      durationMs: 2 * 60 * 60_000,
    });
    expect(parseCompetitiveSpawnAdminAction("/competitivo incenso parar")).toEqual({
      kind: "INCENSE_STOP",
    });
  });

  it("rejects incense windows outside the guarded range", () => {
    expect(parseCompetitiveSpawnAdminAction("/competitivo incenso 1m")).toBeNull();
    expect(parseCompetitiveSpawnAdminAction("/competitivo incenso 5h")).toBeNull();
  });

  it("maps Incense to a stable 3-5 point target from the cycle roll", () => {
    expect(competitiveIncenseTargetMilli(0)).toBe(3_000);
    expect(competitiveIncenseTargetMilli(9_999)).toBe(5_000);
    expect(competitiveIncenseTargetMilli(5_000)).toBeGreaterThanOrEqual(3_000);
    expect(competitiveIncenseTargetMilli(5_000)).toBeLessThanOrEqual(5_000);
  });

  it("does not raise an already lowered cycle after Incense stops", () => {
    const roll = 9_999;
    const normal = competitiveActivityTargetMilli(1, roll);
    const lowered = Math.min(
      competitiveActivityMonotoneTargetMilli({
        previousTargetMilli: normal,
        activeParticipants: 1,
        roll,
        resetCycle: false,
      }),
      competitiveIncenseTargetMilli(roll),
    );

    const afterStop = competitiveActivityMonotoneTargetMilli({
      previousTargetMilli: lowered,
      activeParticipants: 1,
      roll,
      resetCycle: false,
    });

    expect(lowered).toBe(5_000);
    expect(afterStop).toBe(lowered);
  });
});
