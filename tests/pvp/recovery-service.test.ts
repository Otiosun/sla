import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BattleState } from "../../src/modules/battle/contracts.js";
import type { TurnWindowAggregate } from "../../src/modules/battle/turn-window.js";
import { PvpService } from "../../src/modules/pvp/service.js";
import { ManualClock } from "../../src/platform/clock/index.js";

interface RecoveryRecord {
  readonly battleId: string;
  readonly state: BattleState;
  readonly turnWindow: TurnWindowAggregate;
}

interface RecoveryRepositoryDouble {
  activeForPlayer(playerId: string): Promise<RecoveryRecord | null>;
}

interface ResolverDouble {
  resolve(turnWindowId: string): Promise<{
    ok: true;
    value: {
      readonly state: BattleState;
      readonly events: readonly [];
      readonly replayed: boolean;
    };
  }>;
}

interface RecoverEncounterMethod {
  recoverEncounter(input: { readonly playerId: string }): Promise<{
    ok: boolean;
    value?: {
      readonly battleId: string;
      readonly state: BattleState;
      readonly turnWindow: TurnWindowAggregate["window"] | null;
      readonly resolvedLocked: boolean;
    };
  }>;
}

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

function battleState(
  battleId: string,
  version: number,
  status: BattleState["status"],
): BattleState {
  return {
    battleId,
    version,
    status,
  } as BattleState;
}

function aggregate(input: {
  readonly battleId: string;
  readonly version: number;
  readonly status: "COLLECTING" | "LOCKED";
  readonly deadlineAt: string;
}): TurnWindowAggregate {
  return {
    window: {
      id: randomUUID(),
      battleId: input.battleId,
      battleVersion: input.version,
      turnNumber: input.version,
      status: input.status,
      openedAt: "2026-08-31T18:00:00.000Z",
      deadlineAt: input.deadlineAt,
      lockedAt: input.status === "LOCKED" ? "2026-08-31T18:00:10.000Z" : null,
      committedAt: null,
      revision: input.status === "LOCKED" ? 2 : 0,
      resolutionCorrelationId: null,
      resolvedBattleVersion: null,
      requiredPlayers: [
        { playerId: randomUUID(), sideNo: 1 },
        { playerId: randomUUID(), sideNo: 2 },
      ],
    },
    submissions: [],
  };
}

function serviceWithRecovery(
  repository: RecoveryRepositoryDouble,
  resolver: ResolverDouble,
): PvpService & RecoverEncounterMethod {
  const ServiceConstructor = PvpService as unknown as new (...args: unknown[]) => PvpService;
  return new ServiceConstructor(
    challengeRepository(),
    seedProvider(),
    new ManualClock(new Date("2026-08-31T18:02:00.000Z")),
    { enabled: true, reason: null },
    { challengeTtlMs: 300_000, turnWindowTtlMs: 300_000 },
    undefined,
    repository,
    resolver,
  ) as PvpService & RecoverEncounterMethod;
}

describe("PvpService recovery", () => {
  it("returns the persisted COLLECTING window without changing its original deadline", async () => {
    const playerId = randomUUID();
    const battleId = randomUUID();
    const current = aggregate({
      battleId,
      version: 3,
      status: "COLLECTING",
      deadlineAt: "2026-08-31T18:05:00.000Z",
    });
    const repositoryCalls: string[] = [];
    const resolverCalls: string[] = [];
    const repository: RecoveryRepositoryDouble = {
      activeForPlayer: async (requestedPlayerId) => {
        repositoryCalls.push(requestedPlayerId);
        return { battleId, state: battleState(battleId, 3, "ACTIVE"), turnWindow: current };
      },
    };
    const resolver: ResolverDouble = {
      resolve: async (turnWindowId) => {
        resolverCalls.push(turnWindowId);
        return {
          ok: true,
          value: { state: battleState(battleId, 4, "ACTIVE"), events: [], replayed: false },
        };
      },
    };
    const service = serviceWithRecovery(repository, resolver);

    expect(service.recoverEncounter).toBeTypeOf("function");
    const result = await service.recoverEncounter({ playerId });

    expect(result).toEqual({
      ok: true,
      value: {
        battleId,
        state: battleState(battleId, 3, "ACTIVE"),
        turnWindow: current.window,
        resolvedLocked: false,
      },
    });
    expect(repositoryCalls).toEqual([playerId]);
    expect(resolverCalls).toEqual([]);
    expect(result.value?.turnWindow?.deadlineAt).toBe("2026-08-31T18:05:00.000Z");
  });

  it("resolves a persisted LOCKED window once and reloads the next current window", async () => {
    const playerId = randomUUID();
    const battleId = randomUUID();
    const locked = aggregate({
      battleId,
      version: 3,
      status: "LOCKED",
      deadlineAt: "2026-08-31T18:05:00.000Z",
    });
    const next = aggregate({
      battleId,
      version: 4,
      status: "COLLECTING",
      deadlineAt: "2026-08-31T18:07:00.000Z",
    });
    const records: RecoveryRecord[] = [
      { battleId, state: battleState(battleId, 3, "ACTIVE"), turnWindow: locked },
      { battleId, state: battleState(battleId, 4, "ACTIVE"), turnWindow: next },
    ];
    const repositoryCalls: string[] = [];
    const resolverCalls: string[] = [];
    const repository: RecoveryRepositoryDouble = {
      activeForPlayer: async (requestedPlayerId) => {
        repositoryCalls.push(requestedPlayerId);
        return records.shift() ?? null;
      },
    };
    const resolver: ResolverDouble = {
      resolve: async (turnWindowId) => {
        resolverCalls.push(turnWindowId);
        return {
          ok: true,
          value: { state: battleState(battleId, 4, "ACTIVE"), events: [], replayed: false },
        };
      },
    };
    const service = serviceWithRecovery(repository, resolver);

    expect(service.recoverEncounter).toBeTypeOf("function");
    const result = await service.recoverEncounter({ playerId });

    expect(result).toEqual({
      ok: true,
      value: {
        battleId,
        state: battleState(battleId, 4, "ACTIVE"),
        turnWindow: next.window,
        resolvedLocked: true,
      },
    });
    expect(repositoryCalls).toEqual([playerId, playerId]);
    expect(resolverCalls).toEqual([locked.window.id]);
  });
});
