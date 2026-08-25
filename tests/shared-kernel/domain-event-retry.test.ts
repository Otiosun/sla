import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { rootCausality } from "../../src/shared-kernel/causality.js";
import { domainEvent } from "../../src/shared-kernel/domain-event.js";
import { createCorrelationId, createPlayerId } from "../../src/shared-kernel/ids.js";
import { withSafeRetry } from "../../src/shared-kernel/retry.js";

describe("domain events and safe retries", () => {
  it("creates a versioned event envelope with propagated causality", () => {
    const clock = new ManualClock(new Date("2026-08-25T15:30:00.000Z"));
    const correlationId = createCorrelationId();
    const playerId = createPlayerId();

    const event = domainEvent({
      eventType: "PlayerCreated",
      eventVersion: 1,
      aggregate: { type: "Player", id: playerId },
      causality: rootCausality(correlationId),
      payload: { playerId },
      clock,
    });

    expect(event.envelopeVersion).toBe(1);
    expect(event.eventType).toBe("PlayerCreated");
    expect(event.eventVersion).toBe(1);
    expect(event.correlationId).toBe(correlationId);
    expect(event.causationId).toBeNull();
    expect(event.occurredAt).toBe("2026-08-25T15:30:00.000Z");
  });

  it("retries only under an explicitly safe policy", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await withSafeRetry(
      () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(new Error("serialization_failure"));
        }
        return Promise.resolve("done");
      },
      {
        safety: { kind: "IDEMPOTENT_MUTATION", idempotencyKey: "battle:action:123" },
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterRatio: 0,
        isRetryable: (error) =>
          error instanceof Error && error.message === "serialization_failure",
      },
      {
        rng: new DeterministicRandomSource(1),
        sleep: (delayMs) => {
          delays.push(delayMs);
          return Promise.resolve();
        },
      },
    );

    expect(result).toBe("done");
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it("does not retry errors outside the policy classifier", async () => {
    let attempts = 0;
    await expect(
      withSafeRetry(
        () => {
          attempts += 1;
          return Promise.reject(new Error("unknown_mutation_failure"));
        },
        {
          safety: { kind: "READ_ONLY" },
          maxAttempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 10,
          jitterRatio: 0,
          isRetryable: () => false,
        },
        {
          rng: new DeterministicRandomSource(1),
          sleep: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow("unknown_mutation_failure");
    expect(attempts).toBe(1);
  });
});
