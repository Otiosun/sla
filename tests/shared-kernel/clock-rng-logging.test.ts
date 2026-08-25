import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import {
  type LogSink,
  StructuredLogger,
  type StructuredLogEntry,
} from "../../src/platform/logging/index.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { rootCausality } from "../../src/shared-kernel/causality.js";
import { createCorrelationId } from "../../src/shared-kernel/ids.js";

describe("clock, rng and logging", () => {
  it("makes time injectable and controllable", () => {
    const clock = new ManualClock(new Date("2026-08-25T12:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-08-25T12:00:00.000Z");
    clock.advanceMs(2_500);
    expect(clock.now().toISOString()).toBe("2026-08-25T12:00:02.500Z");
  });

  it("replays deterministic RNG from the same test seed", () => {
    const first = new DeterministicRandomSource(123456);
    const second = new DeterministicRandomSource(123456);

    const firstSequence = Array.from({ length: 10 }, () => first.randomInt(1000));
    const secondSequence = Array.from({ length: 10 }, () => second.randomInt(1000));
    expect(firstSequence).toEqual(secondSequence);
    expect(firstSequence.every((value) => value >= 0 && value < 1000)).toBe(true);
  });

  it("redacts secrets, seeds, JIDs, tokens and phone-like values", () => {
    const entries: StructuredLogEntry[] = [];
    const sink: LogSink = {
      write(entry) {
        entries.push(entry);
      },
    };
    const clock = new ManualClock(new Date("2026-08-25T12:00:00.000Z"));
    const correlationId = createCorrelationId();
    const logger = new StructuredLogger(clock, sink);

    logger.log(
      "INFO",
      "battle.action",
      {
        jid: "5511999999999@s.whatsapp.net",
        nested: { token: "super-secret-token", seed: "private-seed" },
        note: "call 5511987654321 later",
        safe: "pikachu",
      },
      rootCausality(correlationId),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      timestamp: "2026-08-25T12:00:00.000Z",
      level: "INFO",
      event: "battle.action",
      correlationId,
      causationId: null,
      context: {
        jid: "[REDACTED]",
        nested: { token: "[REDACTED]", seed: "[REDACTED]" },
        note: "call [REDACTED_PHONE] later",
        safe: "pikachu",
      },
    });
  });
});
