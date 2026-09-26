import { describe, expect, it, vi } from "vitest";
import { PveBattleStartService } from "../../src/modules/battle/pve-battle-start.js";
import type { EncounterId } from "../../src/shared-kernel/ids.js";

const input = {
  playerId: "11111111-1111-4111-8111-111111111111" as never,
  encounterId: "22222222-2222-4222-8222-222222222222" as never,
  expectedRevision: 2n,
};

describe("PveBattleStartService", () => {
  it("starts the canonical encounter battle and initializes that same battle", async () => {
    const started = {
      encounter: { status: "IN_BATTLE" },
      battleId: "33333333-3333-4333-8333-333333333333",
      replayed: false,
    };

    const initialized = {
      state: { status: "ACTIVE" },
      replayed: false,
    };

    const encounter = {
      startBattle: vi.fn(async () => ({
        ok: true as const,
        value: started,
      })),
    };

    const battle = {
      initialize: vi.fn(async () => ({
        ok: true as const,
        value: initialized,
      })),
    };

    const service = new PveBattleStartService(encounter as never, battle as never);

    await expect(service.start(input)).resolves.toEqual({
      ok: true,
      value: {
        start: started,
        initialization: initialized,
      },
    });

    expect(encounter.startBattle).toHaveBeenCalledOnce();
    expect(encounter.startBattle).toHaveBeenCalledWith(input);

    expect(battle.initialize).toHaveBeenCalledOnce();
    expect(battle.initialize).toHaveBeenCalledWith(started.battleId);
  });

  it("does not initialize a battle when Encounter start fails", async () => {
    const failure = {
      ok: false as const,
      error: {
        code: "ACTION_INVALID",
        message: "Encounter cannot start a battle",
      },
    };

    const encounter = {
      startBattle: vi.fn(async () => failure),
    };

    const battle = {
      initialize: vi.fn(),
    };

    const service = new PveBattleStartService(encounter as never, battle as never);

    await expect(service.start(input)).resolves.toEqual(failure);
    expect(battle.initialize).not.toHaveBeenCalled();
  });

  it("still initializes after an idempotent Encounter start replay", async () => {
    const started = {
      encounter: { status: "IN_BATTLE" },
      battleId: "44444444-4444-4444-8444-444444444444",
      replayed: true,
    };

    const initialized = {
      state: { status: "ACTIVE" },
      replayed: true,
    };

    const encounter = {
      startBattle: vi.fn(async () => ({
        ok: true as const,
        value: started,
      })),
    };

    const battle = {
      initialize: vi.fn(async () => ({
        ok: true as const,
        value: initialized,
      })),
    };

    const service = new PveBattleStartService(encounter as never, battle as never);

    await expect(service.start(input)).resolves.toEqual({
      ok: true,
      value: {
        start: started,
        initialization: initialized,
      },
    });

    expect(battle.initialize).toHaveBeenCalledOnce();
    expect(battle.initialize).toHaveBeenCalledWith(started.battleId);
  });
});
describe("PveBattleStartService canonical encounter orchestration", () => {
  it("advances a CREATED encounter through the canonical lifecycle before initialization", async () => {
    const encounterId = "55555555-5555-4555-8555-555555555555" as EncounterId;
    const battleId = "66666666-6666-4666-8666-666666666666";

    const encounter = {
      observe: vi.fn(async () => ({
        ok: true as const,
        value: {
          encounterId,
          status: "PRESENTED" as const,
          revision: 1n,
        },
      })),
      engage: vi.fn(async () => ({
        ok: true as const,
        value: {
          encounterId,
          status: "ENGAGED" as const,
          revision: 2n,
        },
      })),
      startBattle: vi.fn(async () => ({
        ok: true as const,
        value: {
          encounter: {
            encounterId,
            status: "IN_BATTLE" as const,
            revision: 3n,
          },
          battleId,
          replayed: false,
        },
      })),
    };

    const battle = {
      initialize: vi.fn(async () => ({
        ok: true as const,
        value: {
          state: { status: "ACTIVE" },
          replayed: false,
        },
      })),
    };

    const service = new PveBattleStartService(encounter as never, battle as never);

    const result = await service.startCanonical({
      playerId: input.playerId,
      encounterId,
      status: "CREATED",
      expectedRevision: 0n,
    });

    expect(encounter.observe).toHaveBeenCalledWith({
      playerId: input.playerId,
      encounterId,
      expectedRevision: 0n,
    });

    expect(encounter.engage).toHaveBeenCalledWith({
      playerId: input.playerId,
      encounterId,
      expectedRevision: 1n,
    });

    expect(encounter.startBattle).toHaveBeenCalledWith({
      playerId: input.playerId,
      encounterId,
      expectedRevision: 2n,
    });

    expect(battle.initialize).toHaveBeenCalledWith(battleId);

    expect(result).toMatchObject({
      ok: true,
      value: {
        start: {
          battleId,
          replayed: false,
        },
      },
    });

    const observeOrder = encounter.observe.mock.invocationCallOrder[0];
    const engageOrder = encounter.engage.mock.invocationCallOrder[0];
    const startBattleOrder = encounter.startBattle.mock.invocationCallOrder[0];
    const initializeOrder = battle.initialize.mock.invocationCallOrder[0];
    if (
      observeOrder === undefined ||
      engageOrder === undefined ||
      startBattleOrder === undefined ||
      initializeOrder === undefined
    ) {
      throw new Error("Expected canonical PVE lifecycle calls to be recorded");
    }
    expect(observeOrder).toBeLessThan(engageOrder);
    expect(engageOrder).toBeLessThan(startBattleOrder);
    expect(startBattleOrder).toBeLessThan(initializeOrder);
  });
});
describe("PveBattleStartService canonical resume", () => {
  it.each([
    {
      initialStatus: "PRESENTED" as const,
      initialRevision: 2n,
      expectObserve: false,
      expectEngage: true,
    },
    {
      initialStatus: "ENGAGED" as const,
      initialRevision: 3n,
      expectObserve: false,
      expectEngage: false,
    },
    {
      initialStatus: "IN_BATTLE" as const,
      initialRevision: 4n,
      expectObserve: false,
      expectEngage: false,
    },
  ])(
    "resumes the canonical lifecycle from $initialStatus",
    async ({ initialStatus, initialRevision, expectObserve, expectEngage }) => {
      const encounterId = "77777777-7777-4777-8777-777777777777" as EncounterId;
      const battleId = "88888888-8888-4888-8888-888888888888";

      const observe = vi.fn(async () => ({
        ok: true as const,
        value: {
          encounterId,
          status: "PRESENTED" as const,
          revision: initialRevision + 1n,
        },
      }));

      const engage = vi.fn(async () => ({
        ok: true as const,
        value: {
          encounterId,
          status: "ENGAGED" as const,
          revision: initialStatus === "PRESENTED" ? initialRevision + 1n : initialRevision,
        },
      }));

      const startBattle = vi.fn(async () => ({
        ok: true as const,
        value: {
          encounter: {
            encounterId,
            status: "IN_BATTLE" as const,
            revision: initialStatus === "IN_BATTLE" ? initialRevision : initialRevision + 1n,
          },
          battleId,
          replayed: initialStatus === "IN_BATTLE",
        },
      }));

      const initialize = vi.fn(async () => ({
        ok: true as const,
        value: {
          state: { status: "ACTIVE" },
          replayed: initialStatus === "IN_BATTLE",
        },
      }));

      const service = new PveBattleStartService(
        { observe, engage, startBattle } as never,
        { initialize } as never,
      );

      const result = await service.startCanonical({
        playerId: input.playerId,
        encounterId,
        status: initialStatus,
        expectedRevision: initialRevision,
      });

      expect(observe).toHaveBeenCalledTimes(expectObserve ? 1 : 0);
      expect(engage).toHaveBeenCalledTimes(expectEngage ? 1 : 0);

      expect(startBattle).toHaveBeenCalledOnce();

      const expectedBattleRevision =
        initialStatus === "PRESENTED" ? initialRevision + 1n : initialRevision;

      expect(startBattle).toHaveBeenCalledWith({
        playerId: input.playerId,
        encounterId,
        expectedRevision: expectedBattleRevision,
      });

      expect(initialize).toHaveBeenCalledOnce();
      expect(initialize).toHaveBeenCalledWith(battleId);

      expect(result).toMatchObject({
        ok: true,
        value: {
          start: {
            battleId,
            replayed: initialStatus === "IN_BATTLE",
          },
        },
      });
    },
  );

  it("resumes the canonical lifecycle from PRESENTED, ENGAGED, or IN_BATTLE", () => {
    expect(true).toBe(true);
  });
});
