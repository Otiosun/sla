import { describe, expect, it, vi } from "vitest";
import * as pveBattleModule from "../../src/modules/battle/pve-battle-start.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "11111111-1111-4111-8111-111111111111";
const BATTLE_ID = "33333333-3333-4333-8333-333333333333";
const ENCOUNTER_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_REF = "target:123@s.whatsapp.net";

type Route = {
  command: string;
  rateLimitClass?: string;
  policy?: {
    requiredAnyGroupCapabilities?: readonly string[];
    requiredAdminCapability?: string;
  };
  handler: {
    handle(context: unknown): Promise<unknown>;
  };
};

type Overrides = {
  activeBattleId?: (playerId: string) => Promise<string | null>;
  currentState?: (battleId: string) => Promise<unknown>;
  cancel?: (input: unknown) => Promise<unknown>;
  cleanup?: (playerId: string) => Promise<{ battleId: string; encounterId: string } | null>;
  activeForPlayer?: (playerId: string) => Promise<unknown>;
  flee?: (input: unknown) => Promise<unknown>;
};

function createHarness(overrides: Overrides = {}) {
  const resolvePlayer = vi.fn(async () => ok({ playerId: PLAYER_ID, state: "COMPLETE" as const }));

  const activeBattleId = vi.fn(
    overrides.activeBattleId ?? (async (_playerId: string): Promise<string | null> => BATTLE_ID),
  );

  const currentState = vi.fn(
    overrides.currentState ?? (async (_battleId: string): Promise<unknown> => ok({ version: 7 })),
  );

  const cancel = vi.fn(
    overrides.cancel ?? (async (_input: unknown): Promise<unknown> => ok(undefined)),
  );

  const cleanupForPlayer = vi.fn(
    overrides.cleanup ??
      (async (_playerId: string): Promise<{ battleId: string; encounterId: string } | null> =>
        null),
  );

  const activeForPlayer = vi.fn(
    overrides.activeForPlayer ??
      (async (_playerId: string): Promise<unknown> => ({
        ok: false,
        error: { message: "No active encounter" },
      })),
  );

  const flee = vi.fn(
    overrides.flee ?? (async (_input: unknown): Promise<unknown> => ok(undefined)),
  );

  const factory = (
    pveBattleModule as unknown as {
      createPveBattleFinishWhatsAppRoute(input: unknown): Route;
    }
  ).createPveBattleFinishWhatsAppRoute;

  const route = factory({
    players: { resolvePlayer },
    activeBattleId,
    battle: { currentState, cancel },
    encounters: { activeForPlayer },
    encounterWriter: { flee },
    cancelledWildCleanup: { cleanupForPlayer },
  });

  return {
    route,
    mocks: {
      resolvePlayer,
      activeBattleId,
      currentState,
      cancel,
      cleanupForPlayer,
      activeForPlayer,
      flee,
    },
  };
}

function context(idempotencyKey = "inbox:test:finish", mentions: string[] = [TARGET_REF]) {
  return {
    idempotencyKey,
    correlationId: "11111111-1111-4111-8111-111111111111",
    message: {
      provider: "whatsapp",
      senderRef: "admin-wa",
      chatRef: "group-wa",
      text: "/finalizarbatalha @treinador",
      mentions,
    },
  };
}

describe("PVE administrative battle finish WhatsApp route", () => {
  it("requires PVE or WORLD capability and encounter.support", () => {
    const { route } = createHarness();

    expect(route.command).toBe("finalizarbatalha");
    expect(route.rateLimitClass).toBe("SENSITIVE");
    expect(route.policy).toEqual({
      requiredAnyGroupCapabilities: ["pve", "world"],
      requiredAdminCapability: "encounter.support",
    });
  });

  it("cancels the active battle and cleans up the wild encounter", async () => {
    const { route, mocks } = createHarness();

    const result = await route.handler.handle(context());

    expect(mocks.resolvePlayer).toHaveBeenCalledWith({
      provider: "whatsapp",
      externalId: TARGET_REF,
    });

    expect(mocks.activeBattleId).toHaveBeenCalledWith(PLAYER_ID);
    expect(mocks.currentState).toHaveBeenCalledWith(BATTLE_ID);

    expect(mocks.cancel).toHaveBeenCalledWith({
      battleId: BATTLE_ID,
      expectedVersion: 7,
      reason: "NARRATOR_FINISH",
      correlationId: "11111111-1111-4111-8111-111111111111",
    });

    expect(mocks.cleanupForPlayer).toHaveBeenCalledWith(PLAYER_ID);

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "BATTLE",
        resultRefId: BATTLE_ID,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: "group-wa",
            messageType: "TEXT",
            payload: {
              text: "🛑 *BATALHA ENCERRADA* · @target",
              mentions: [TARGET_REF],
            },
            idempotencyKey: "inbox:test:finish:pve-battle-finish",
          },
        ],
      },
    });
  });

  it("rejects missing or multiple real mentions before resolving a player", async () => {
    const { route, mocks } = createHarness();

    const missing = await route.handler.handle(context("missing", []));
    const multiple = await route.handler.handle(
      context("multiple", [TARGET_REF, "another:123@s.whatsapp.net"]),
    );

    expect(missing).toMatchObject({ ok: false });
    expect(multiple).toMatchObject({ ok: false });
    expect(mocks.resolvePlayer).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("does not clean up when the canonical cancellation fails", async () => {
    const { route, mocks } = createHarness({
      cancel: async () => ({
        ok: false,
        error: { message: "Version conflict" },
      }),
    });

    const result = await route.handler.handle(context());

    expect(result).toMatchObject({ ok: false });
    expect(mocks.cleanupForPlayer).not.toHaveBeenCalled();
  });

  it("recovers a cancelled battle whose wild cleanup is pending", async () => {
    const { route, mocks } = createHarness({
      activeBattleId: async () => null,
      cleanup: async () => ({ battleId: BATTLE_ID, encounterId: ENCOUNTER_ID }),
    });

    const result = await route.handler.handle(context());

    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.cleanupForPlayer).toHaveBeenCalledWith(PLAYER_ID);
    expect(mocks.activeForPlayer).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "BATTLE",
        resultRefId: BATTLE_ID,
        outgoing: [
          {
            payload: {
              text: "🛑 *BATALHA ENCERRADA* · @target",
              mentions: [TARGET_REF],
            },
            idempotencyKey: "inbox:test:finish:pve-battle-finish-recovered",
          },
        ],
      },
    });
  });

  it("finishes an eligible encounter when no battle exists", async () => {
    const { route, mocks } = createHarness({
      activeBattleId: async () => null,
      activeForPlayer: async () =>
        ok({
          encounterId: ENCOUNTER_ID,
          status: "CREATED",
          revision: 3n,
        }),
    });

    const result = await route.handler.handle(context());

    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.flee).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      encounterId: ENCOUNTER_ID,
      expectedRevision: 3n,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "ENCOUNTER",
        resultRefId: ENCOUNTER_ID,
      },
    });
  });

  it("refuses an encounter in a mechanical transition", async () => {
    const { route, mocks } = createHarness({
      activeBattleId: async () => null,
      activeForPlayer: async () =>
        ok({
          encounterId: ENCOUNTER_ID,
          status: "RESOLVING",
          revision: 4n,
        }),
    });

    const result = await route.handler.handle(context());

    expect(result).toMatchObject({ ok: false });
    expect(mocks.flee).not.toHaveBeenCalled();
  });

  it("recovers after cancellation succeeds but cleanup temporarily fails", async () => {
    let activeReads = 0;
    let cleanupCalls = 0;

    const { route, mocks } = createHarness({
      activeBattleId: async () => {
        activeReads += 1;
        return activeReads === 1 ? BATTLE_ID : null;
      },
      cleanup: async () => {
        cleanupCalls += 1;

        if (cleanupCalls === 1) {
          throw new Error("Simulated cleanup interruption");
        }

        return { battleId: BATTLE_ID, encounterId: ENCOUNTER_ID };
      },
    });

    await expect(route.handler.handle(context("first-attempt"))).rejects.toThrow(
      "Simulated cleanup interruption",
    );

    const recovered = await route.handler.handle(context("retry-attempt"));

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupForPlayer).toHaveBeenCalledTimes(2);

    expect(recovered).toMatchObject({
      ok: true,
      value: {
        resultRefType: "BATTLE",
        resultRefId: BATTLE_ID,
      },
    });
  });
});
