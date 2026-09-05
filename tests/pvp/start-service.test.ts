import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PvpStartRepository, PvpStartRepositoryInput } from "../../src/modules/pvp/ports.js";
import { PvpService } from "../../src/modules/pvp/service.js";
import { ManualClock } from "../../src/platform/clock/index.js";

function challengeRepository() {
  const transaction = {};
  return {
    transaction: async <T>(work: (tx: typeof transaction) => Promise<T>): Promise<T> =>
      work(transaction),
    read: async <T>(work: (tx: typeof transaction) => Promise<T>): Promise<T> => work(transaction),
  };
}

function seedProvider() {
  return {
    create: () => ({
      seed: new Uint8Array(32).fill(1),
      envelope: {
        ciphertext: new Uint8Array(32).fill(2),
        iv: new Uint8Array(12).fill(3),
        authTag: new Uint8Array(16).fill(4),
        keyVersion: 1,
      },
    }),
  };
}

function startRepository() {
  const calls: PvpStartRepositoryInput[] = [];
  const output = {
    challengeId: randomUUID(),
    encounterId: randomUUID(),
    battleId: randomUUID(),
    turnWindowId: randomUUID(),
    replayed: false,
  } as const;
  const repository: PvpStartRepository = {
    start: async (input) => {
      calls.push(input);
      return { ok: true, value: output };
    },
  };
  return { repository, calls, output };
}

describe("PvpService START", () => {
  it("uses the service clock and configured TurnWindow TTL and preserves repository output", async () => {
    const clock = new ManualClock(new Date("2026-08-31T14:00:00.000Z"));
    const start = startRepository();
    const service = new PvpService(
      challengeRepository() as never,
      seedProvider(),
      clock,
      { enabled: true, reason: null },
      { challengeTtlMs: 300_000, turnWindowTtlMs: 120_000 },
      start.repository,
    );
    const actorPlayerId = randomUUID();

    const result = await service.startEncounter({
      challengeId: start.output.challengeId,
      actorPlayerId,
    });

    expect(result).toEqual({ ok: true, value: start.output });
    expect(start.calls).toEqual([
      {
        challengeId: start.output.challengeId,
        actorPlayerId,
        startedAt: new Date("2026-08-31T14:00:00.000Z"),
        deadlineAt: new Date("2026-08-31T14:02:00.000Z"),
      },
    ]);
  });

  it("fails before delegation when the PVP feature is disabled", async () => {
    const clock = new ManualClock(new Date("2026-08-31T14:00:00.000Z"));
    const start = startRepository();
    const service = new PvpService(
      challengeRepository() as never,
      seedProvider(),
      clock,
      { enabled: false, reason: "pvp-disabled" },
      { challengeTtlMs: 300_000, turnWindowTtlMs: 120_000 },
      start.repository,
    );

    const result = await service.startEncounter({
      challengeId: start.output.challengeId,
      actorPlayerId: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FEATURE_UNAVAILABLE");
    expect(start.calls).toHaveLength(0);
  });

  it("fails closed when START infrastructure is not configured", async () => {
    const service = new PvpService(
      challengeRepository() as never,
      seedProvider(),
      new ManualClock(new Date("2026-08-31T14:00:00.000Z")),
      { enabled: true, reason: null },
      { challengeTtlMs: 300_000 },
    );

    const result = await service.startEncounter({
      challengeId: randomUUID(),
      actorPlayerId: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FEATURE_UNAVAILABLE");
    expect(result.error.details?.reason).toBe("pvp-start-not-configured");
  });
});
