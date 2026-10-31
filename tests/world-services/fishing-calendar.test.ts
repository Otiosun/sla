import { describe, expect, it } from "vitest";
import { fishingDayKey } from "../../src/modules/world-services/fishing-calendar.js";

describe("Fishing world day must be an explicitly configured calendar", () => {
  it("changes local day at the configured boundary, not midnight UTC", () => {
    expect(fishingDayKey(new Date("2026-10-31T02:59:59.999Z"), "America/Recife")).toBe(
      "2026-10-30",
    );
    expect(fishingDayKey(new Date("2026-10-31T03:00:00.000Z"), "America/Recife")).toBe(
      "2026-10-31",
    );
    expect(fishingDayKey(new Date("2026-10-31T02:59:59.999Z"), "Etc/UTC")).toBe("2026-10-31");
  });

  it("works across month and year without inheriting host timezone", () => {
    expect(fishingDayKey(new Date("2027-01-01T00:59:00.000Z"), "America/Recife")).toBe(
      "2026-12-31",
    );
    expect(fishingDayKey(new Date("2026-12-31T15:00:00.000Z"), "Asia/Tokyo")).toBe("2027-01-01");
  });

  it("rejects missing or invalid timezone and invalid clock dates", () => {
    expect(() => fishingDayKey(new Date(), "")).toThrow();
    expect(() => fishingDayKey(new Date(), "Mars/Zhoulia")).toThrow();
    expect(() => fishingDayKey(new Date(NaN), "Etc/UTC")).toThrow();
  });
});
