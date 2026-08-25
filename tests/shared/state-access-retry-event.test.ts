import { describe, expect, it } from "vitest";
import { MAX_SLEEP_MS, type Sleeper } from "../../src/platform/clock/index.js";
import {
  asBattleId,
  asCausationId,
  asCorrelationId,
  asDomainEventId,
  asPlayerId,
  childTrace,
  domainEvent,
  evaluateAccess,
  rootTrace,
  runWithSafeRetry,
  StateMachine,
  type AccessPolicies,
  type Repository,
  type RetrySafety,
  type TransactionRunner,
} from "../../src/platform/shared/index.js";

const PLAYER_ID = asPlayerId("11111111-1111-4111-8111-111111111111");

describe("state, access, retry, events and ports", () => {
  it("allows only declared state transitions and snapshots policy at construction", () => {
    type State = "NEW" | "READY" | "DONE";
    const mutableNewTargets: State[] = ["READY"];
    const machine = new StateMachine<State>({
      NEW: mutableNewTargets,
      READY: ["DONE"],
      DONE: [],
    });

    mutableNewTargets.splice(0, 1, "DONE");
    expect(machine.canTransition("NEW", "READY")).toBe(true);
    expect(machine.canTransition("NEW", "DONE")).toBe(false);
    expect(machine.transition("NEW", "READY")).toEqual({ ok: true, value: "READY" });
    const invalid = machine.transition("NEW", "DONE");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("STATE.INVALID_TRANSITION");
      expect(invalid.error.details).toEqual({ from: "NEW", to: "DONE" });
    }
  });

  it("keeps feature availability, player eligibility, flow and action validation separate", () => {
    const policies: AccessPolicies<"IDLE", { readonly legal: boolean }, "PLAY"> = {
      featureAvailability: { check: () => ({ allowed: true }) },
      playerEligibility: {
        check: () => ({
          allowed: false,
          code: "PLAYER.NOT_ELIGIBLE",
          message: "player cannot use this feature",
        }),
      },
      flowState: { check: () => ({ allowed: true }) },
      actionValidation: { check: () => ({ allowed: true }) },
    };

    expect(
      evaluateAccess({
        policies,
        playerId: PLAYER_ID,
        featureKey: "pokemon.travel",
        flowState: "IDLE",
        state: { legal: true },
        action: "PLAY",
      }),
    ).toEqual({
      allowed: false,
      stage: "PLAYER_ELIGIBILITY",
      code: "PLAYER.NOT_ELIGIBLE",
      message: "player cannot use this feature",
    });
  });

  it("retries only through an explicitly safe and timer-bounded contract", async () => {
    const delays: number[] = [];
    const sleeper: Sleeper = {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    };
    let calls = 0;

    const result = await runWithSafeRetry({
      safety: "IDEMPOTENT",
      policy: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100 },
      sleeper,
      shouldRetry: () => true,
      operation: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("transient");
        }
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);

    await expect(
      runWithSafeRetry({
        safety: "READ_ONLY",
        policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: MAX_SLEEP_MS + 1 },
        sleeper,
        shouldRetry: () => true,
        operation: async () => "never",
      }),
    ).rejects.toThrow(/maxDelayMs/);

    // @ts-expect-error Unknown mutation safety must never opt into automatic retry.
    const unsafeSafety: RetrySafety = "UNKNOWN";
    expect(unsafeSafety).toBe("UNKNOWN");
  });

  it("propagates correlation while changing causation and versions events", () => {
    const correlationId = asCorrelationId("33333333-3333-4333-8333-333333333333");
    const causationId = asCausationId("44444444-4444-4444-8444-444444444444");
    const root = rootTrace(correlationId);
    const child = childTrace(root, causationId);

    expect(root).toEqual({ correlationId, causationId: null });
    expect(child).toEqual({ correlationId, causationId });

    const event = domainEvent({
      eventId: asDomainEventId("55555555-5555-4555-8555-555555555555"),
      eventType: "BattleStarted",
      eventVersion: 1,
      aggregateType: "battle",
      aggregateId: asBattleId("66666666-6666-4666-8666-666666666666"),
      payload: { source: "encounter" },
      occurredAt: new Date("2026-08-25T15:00:00.000Z"),
      correlationId,
      causationId,
    });

    expect(event.eventVersion).toBe(1);
    expect(event.correlationId).toBe(correlationId);
    expect(event.causationId).toBe(causationId);

    domainEvent({
      eventId: asDomainEventId("77777777-7777-4777-8777-777777777777"),
      eventType: "InvalidAggregateProbe",
      eventVersion: 1,
      aggregateType: "battle",
      // @ts-expect-error Domain events must use nominal internal aggregate IDs.
      aggregateId: "88888888-8888-4888-8888-888888888888",
      payload: {},
      occurredAt: new Date("2026-08-25T15:00:00.000Z"),
      correlationId,
      causationId,
    });
  });

  it("keeps transaction and repository contracts infrastructure-neutral", async () => {
    type Transaction = { readonly id: string };
    type Entity = { readonly id: string; readonly value: string };

    const runner: TransactionRunner<Transaction> = {
      runInTransaction: async (work) => work({ id: "tx-1" }),
    };
    const repository: Repository<Entity, string, Transaction> = {
      getById: async (_transaction, id) => (id === "1" ? { id: "1", value: "stored" } : null),
      insert: async () => undefined,
      update: async () => undefined,
    };

    const value = await runner.runInTransaction(async (transaction) =>
      repository.getById(transaction, "1"),
    );
    expect(value).toEqual({ id: "1", value: "stored" });
  });
});
