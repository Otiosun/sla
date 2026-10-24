import { describe, expect, it } from "vitest";
import { expeditionClock } from "../../src/modules/exploration/expedition-clock.js";
import {
  advanceExpedition,
  endExpedition,
  expeditionRequiresReport,
  type ExpeditionSnapshot,
} from "../../src/modules/exploration/expedition-state.js";

const WEEK = "2026-10-19";

function preparing(): ExpeditionSnapshot {
  return {
    expeditionId: "expedition-01",
    playerId: "trainer-01",
    period: "DAY",
    areaId: "vila-dos-arrozais",
    currentAreaId: "vila-dos-arrozais",
    phase: "PREPARING",
    elapsedMinutes: 0,
    consumedWeekKey: null,
    endReason: null,
    revision: 0n,
  };
}

function advance(expedition: ExpeditionSnapshot, minutes: number, consumedThisWeek = 0) {
  return advanceExpedition({
    expedition,
    minutes,
    weekKey: WEEK,
    consumedThisWeek,
    expectedRevision: expedition.revision,
  });
}

describe("expedition session state transitions", () => {
  it("does not consume a weekly slot when consulting the free preparation menu", () => {
    const original = preparing();
    const result = advance(original, 0);
    expect(result).toEqual({
      ok: true,
      value: { expedition: original, consumedWeeklySlot: false, changed: false },
    });
    expect(original.phase).toBe("PREPARING");
    expect(original.consumedWeekKey).toBeNull();
  });

  it("consumes exactly one slot on the first timed action and records its Monday", () => {
    const original = preparing();
    const result = advance(original, 30, 2);
    expect(result).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: true,
        changed: true,
        expedition: {
          phase: "ACTIVE",
          elapsedMinutes: 30,
          consumedWeekKey: WEEK,
          revision: 1n,
        },
      },
    });
    expect(original.elapsedMinutes).toBe(0);
    if (!result.ok) return;
    expect(expeditionClock("DAY", result.value.expedition.elapsedMinutes).currentTime).toBe(
      "06:30",
    );
  });

  it("continues an active expedition across weekly reset without charging again", () => {
    const first = advance(preparing(), 30);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const result = advanceExpedition({
      expedition: first.value.expedition,
      minutes: 15,
      weekKey: "2026-10-26",
      consumedThisWeek: 3,
      expectedRevision: 1n,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: false,
        expedition: {
          phase: "ACTIVE",
          elapsedMinutes: 45,
          consumedWeekKey: WEEK,
          revision: 2n,
        },
      },
    });
  });

  it("refuses a fourth first action without consuming time", () => {
    const original = preparing();
    expect(advance(original, 30, 3)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(original).toEqual(preparing());
  });

  it("refuses actions that exceed the remaining 12-hour clock", () => {
    const active: ExpeditionSnapshot = {
      ...preparing(),
      phase: "ACTIVE",
      elapsedMinutes: 700,
      consumedWeekKey: WEEK,
      revision: 4n,
    };
    expect(advance(active, 30)).toMatchObject({
      ok: false,
      error: {
        code: "FLOW_BLOCKED",
        details: { remainingMinutes: 20 },
      },
    });
    expect(active.elapsedMinutes).toBe(700);
  });

  it("automatically ends at exactly 12 internal hours and makes a report eligible", () => {
    const active: ExpeditionSnapshot = {
      ...preparing(),
      period: "NIGHT",
      phase: "ACTIVE",
      elapsedMinutes: 690,
      consumedWeekKey: WEEK,
      revision: 1n,
    };
    const last = advance(active, 30);
    expect(last).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: false,
        expedition: {
          phase: "ENDED",
          elapsedMinutes: 720,
          endReason: "CLOCK",
          revision: 2n,
        },
      },
    });
    if (!last.ok) return;
    expect(expeditionClock("NIGHT", last.value.expedition.elapsedMinutes).currentTime).toBe(
      "06:00",
    );
    expect(expeditionRequiresReport(last.value.expedition)).toBe(true);
    expect(advance(last.value.expedition, 30)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("cancels a prepared expedition without debiting or creating a report", () => {
    const cancelled = endExpedition({
      expedition: preparing(),
      expectedRevision: 0n,
      reason: "CANCELLED",
    });
    expect(cancelled).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: false,
        expedition: { phase: "ENDED", endReason: "CANCELLED", consumedWeekKey: null },
      },
    });
    if (!cancelled.ok) return;
    expect(expeditionRequiresReport(cancelled.value.expedition)).toBe(false);
  });

  it("requires time spent for voluntary closure and gives no report reward after blackout", () => {
    const unstarted = preparing();
    expect(
      endExpedition({
        expedition: unstarted,
        expectedRevision: 0n,
        reason: "BLACKOUT",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });

    const first = advance(unstarted, 30);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const voluntary = endExpedition({
      expedition: first.value.expedition,
      expectedRevision: 1n,
      reason: "VOLUNTARY",
    });
    const blackout = endExpedition({
      expedition: first.value.expedition,
      expectedRevision: 1n,
      reason: "BLACKOUT",
    });
    expect(voluntary.ok).toBe(true);
    expect(blackout.ok).toBe(true);
    if (!voluntary.ok || !blackout.ok) return;
    expect(expeditionRequiresReport(voluntary.value.expedition)).toBe(true);
    expect(expeditionRequiresReport(blackout.value.expedition)).toBe(false);
    expect(blackout.value.expedition.consumedWeekKey).toBe(WEEK);
  });

  it("rejects stale revisions and invalid durations without mutating the snapshot", () => {
    const original = preparing();
    expect(
      advanceExpedition({
        expedition: original,
        expectedRevision: 1n,
        weekKey: WEEK,
        consumedThisWeek: 0,
        minutes: 30,
      }),
    ).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    for (const minutes of [-1, Number.NaN, 0.5, 721]) {
      expect(advance(original, minutes)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
    }
    expect(original).toEqual(preparing());
  });

  it("accepts only a real Monday as the first-debit calendar key", () => {
    for (const weekKey of ["2026-10-20", "2026-02-30", "week-1"]) {
      expect(
        advanceExpedition({
          expedition: preparing(),
          expectedRevision: 0n,
          minutes: 30,
          weekKey,
          consumedThisWeek: 0,
        }),
      ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
  });
});
