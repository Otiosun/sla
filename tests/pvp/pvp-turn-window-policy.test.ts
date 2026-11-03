import { describe, expect, it } from "vitest";
import {
  DEFAULT_PVP_TURN_WINDOW_TTL_MS,
  initialPvpTiming,
} from "../../src/modules/pvp/turn-window-policy.js";

describe("owner-approved PvP turn default (original UX archive 26/10)", () => {
  it("uses 12 hours for a new PvP turn independent of seven-day PvE timeout", () => {
    const pveSevenDays = 7 * 24 * 60 * 60 * 1_000;
    expect(DEFAULT_PVP_TURN_WINDOW_TTL_MS).toBe(12 * 60 * 60 * 1_000);
    expect(initialPvpTiming(pveSevenDays)).toEqual({
      challengeTtlMs: pveSevenDays,
      turnWindowTtlMs: 12 * 60 * 60 * 1_000,
    });
  });

  it("does not reinterpret another configured PvE timeout as PvP turn policy", () => {
    expect(initialPvpTiming(30 * 60 * 1_000).turnWindowTtlMs).toBe(
      DEFAULT_PVP_TURN_WINDOW_TTL_MS,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid upstream timing %s",
    (input) => {
      expect(() => initialPvpTiming(input)).toThrow();
    },
  );
});
