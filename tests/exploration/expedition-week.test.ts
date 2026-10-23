import { describe, expect, it } from "vitest";
import {
  expeditionWeekKey,
  expeditionWeeklyAdmission,
} from "../../src/modules/exploration/expedition-week.js";

describe("solo expedition calendar and weekly admission", () => {
  it("resets at the configured region's Monday 00:00, not host UTC midnight", () => {
    expect(expeditionWeekKey(new Date("2026-10-26T02:59:59Z"), "America/Maceio")).toBe(
      "2026-10-19",
    );
    expect(expeditionWeekKey(new Date("2026-10-26T03:00:00Z"), "America/Maceio")).toBe(
      "2026-10-26",
    );
    expect(expeditionWeekKey(new Date("2026-10-25T15:00:00Z"), "Asia/Tokyo")).toBe("2026-10-26");
  });

  it("handles month/year changes and DST without deriving the week from UTC", () => {
    expect(expeditionWeekKey(new Date("2027-01-01T12:00:00Z"), "UTC")).toBe("2026-12-28");
    expect(expeditionWeekKey(new Date("2026-11-02T04:59:59Z"), "America/New_York")).toBe(
      "2026-10-26",
    );
    expect(expeditionWeekKey(new Date("2026-11-02T05:00:00Z"), "America/New_York")).toBe(
      "2026-11-02",
    );
  });

  it("fails closed on invalid instants or timezone", () => {
    expect(() => expeditionWeekKey(new Date(Number.NaN), "UTC")).toThrow(RangeError);
    expect(() => expeditionWeekKey(new Date(), "not-a-timezone")).toThrow(RangeError);
  });

  it("keeps preparation free, rejects the fourth expedition and allows resume", () => {
    expect(expeditionWeeklyAdmission(0, false)).toEqual({
      remaining: 3,
      canPrepare: true,
      canConsumeFirstAction: true,
      resumeExisting: false,
    });
    expect(expeditionWeeklyAdmission(2, false).remaining).toBe(1);
    expect(expeditionWeeklyAdmission(3, false)).toEqual({
      remaining: 0,
      canPrepare: false,
      canConsumeFirstAction: false,
      resumeExisting: false,
    });
    expect(expeditionWeeklyAdmission(3, true)).toEqual({
      remaining: 0,
      canPrepare: false,
      canConsumeFirstAction: false,
      resumeExisting: true,
    });
  });

  it("refuses invalid or manipulated counters rather than silently clamping them", () => {
    for (const count of [-1, 4, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => expeditionWeeklyAdmission(count, false)).toThrow(RangeError);
    }
  });
});
