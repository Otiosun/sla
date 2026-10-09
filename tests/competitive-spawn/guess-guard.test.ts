import { describe, expect, it } from "vitest";

const MIN_INTERVAL_MS = 1_200;
const MAX_ATTEMPTS = 50;

function admitted(input: { count: number; lastAt: Date | null; now: Date }): boolean {
  if (input.count >= MAX_ATTEMPTS) return false;
  if (input.lastAt === null) return true;
  return input.now.getTime() - input.lastAt.getTime() >= MIN_INTERVAL_MS;
}

describe("competitive guess mechanical guard contract", () => {
  it("allows a solo player to keep playing at a human cadence", () => {
    expect(
      admitted({
        count: 12,
        lastAt: new Date("2026-10-08T12:00:00.000Z"),
        now: new Date("2026-10-08T12:00:01.200Z"),
      }),
    ).toBe(true);
  });

  it("silently rejects machine-like cadence without classifying ordinary chat as spam", () => {
    expect(
      admitted({
        count: 12,
        lastAt: new Date("2026-10-08T12:00:00.000Z"),
        now: new Date("2026-10-08T12:00:00.300Z"),
      }),
    ).toBe(false);
  });

  it("caps accepted guesses per player per spawn", () => {
    expect(admitted({ count: 50, lastAt: null, now: new Date() })).toBe(false);
  });
});
