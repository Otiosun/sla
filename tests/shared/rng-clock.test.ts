import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/platform/clock/index.js";
import {
  generatePrivateSeed,
  HmacCounterRandomSource,
  RNG_SEED_BYTES,
} from "../../src/platform/rng/index.js";

describe("clock and rng", () => {
  it("replays the same sequence from the same seed and counter", () => {
    const seed = new Uint8Array(RNG_SEED_BYTES).fill(7);
    const left = new HmacCounterRandomSource(seed, 3n);
    const right = new HmacCounterRandomSource(seed, 3n);

    const leftSequence = Array.from({ length: 8 }, () => left.nextUint32());
    const rightSequence = Array.from({ length: 8 }, () => right.nextUint32());

    expect(leftSequence).toEqual(rightSequence);
    expect(left.getCounter()).toBe(11n);
    expect(right.getCounter()).toBe(11n);
  });

  it("produces bounded integers without allowing invalid ranges", () => {
    const rng = new HmacCounterRandomSource(new Uint8Array(RNG_SEED_BYTES).fill(3));
    for (let index = 0; index < 100; index += 1) {
      const value = rng.nextInt(5, 9);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(9);
    }
    expect(() => rng.nextInt(4, 4)).toThrow(/greater/);
  });

  it("generates production seeds with the canonical length", () => {
    expect(generatePrivateSeed()).toHaveLength(RNG_SEED_BYTES);
    expect(generatePrivateSeed()).not.toEqual(generatePrivateSeed());
  });

  it("supports deterministic time in tests", () => {
    const clock = new FixedClock(new Date("2026-08-25T12:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-08-25T12:00:00.000Z");

    clock.advance(5_000);
    expect(clock.now().toISOString()).toBe("2026-08-25T12:00:05.000Z");

    const returned = clock.now();
    returned.setUTCFullYear(2030);
    expect(clock.now().toISOString()).toBe("2026-08-25T12:00:05.000Z");
  });
});
