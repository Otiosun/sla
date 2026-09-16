import { describe, expect, it, vi } from "vitest";
import type { BattleState } from "../../src/modules/battle/contracts.js";
import type { BattleParticipantController } from "../../src/modules/battle/participant-controller.js";
import {
  createPveSceneConversationResolver,
  createPveSceneRoutes,
  type PveSceneDependencies,
} from "../../src/modules/battle/pve-scene-whatsapp.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { ok } from "../../src/shared-kernel/result.js";

const battleId = "11111111-1111-4111-8111-111111111111";
const playerId = "22222222-2222-4222-8222-222222222222";
const participantId = "33333333-3333-4333-8333-333333333333";
const enemyId = "44444444-4444-4444-8444-444444444444";

const state = {
  battleId,
  version: 4,
  turnNumber: 3,
  combatants: [
    { participantId, sideNo: 1, currentHp: 12, maxHp: 20 },
    { participantId: enemyId, sideNo: 2, currentHp: 10, maxHp: 20 },
  ],
} as BattleState;

function context(
  text: string,
  input: { readonly senderRef?: string; readonly idempotencyKey?: string } = {},
): MessageHandlerContext {
  return {
    inboxMessageId: "inbox",
    correlationId: "correlation",
    causationId: "cause",
    idempotencyKey: input.idempotencyKey ?? "message-1",
    message: {
      provider: "baileys",
      externalMessageId: "message",
      senderRef: input.senderRef ?? "sender",
      chatRef: "chat",
      occurredAt: "2026-09-10T00:00:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function dependencies(pending: boolean) {
  const resolvePlayerTurn = vi.fn(async () =>
    ok({ state, events: [], replayed: false, ...(pending ? { pending: true } : {}) }),
  );
  const listByBattle = vi.fn(
    async (): Promise<readonly BattleParticipantController[]> => [
      {
        participantId,
        battleId,
        kind: "PLAYER" as const,
        playerId,
        adminPrincipalId: null,
        revision: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  );
  const transition = vi.fn();
  const resolvePrincipal = vi.fn(
    async (): Promise<{ readonly principalId: string } | null> => null,
  );
  return {
    resolvePlayerTurn,
    listByBattle,
    transition,
    resolvePrincipal,
    dependencies: {
      players: { resolvePlayer: vi.fn(async () => ok({ playerId })) },
      activeBattleId: vi.fn(async () => battleId),
      battle: { currentState: vi.fn(async () => ok(state)), resolvePlayerTurn },
      controllers: {
        listByBattle,
        transition,
      },
      admins: { resolvePrincipal },
    } as unknown as PveSceneDependencies,
  };
}

function routeFor(routes: ReturnType<typeof createPveSceneRoutes>, command: string) {
  const route = routes.find((entry) => entry.command === command);
  if (route === undefined) throw new Error(`Missing ${command} route`);
  return route;
}

describe("PVE WhatsApp scene actions", () => {
  it("admits scene actions from a PVP-capable group too", () => {
    const setup = dependencies(false);
    const route = routeFor(createPveSceneRoutes(setup.dependencies), "movimento");
    expect(route.policy).toMatchObject({
      requiredAnyGroupCapabilities: ["pve", "pvp"],
      requiresMechanicalReady: true,
    });
  });

  it("forwards each PVP player's own actor and stays silent until the second action resolves", async () => {
    const playerB = "55555555-5555-4555-8555-555555555555";
    const actorB = "66666666-6666-4666-8666-666666666666";
    const pvpState = {
      ...state,
      battleType: "PVP" as const,
      combatants: [
        ...state.combatants,
        { participantId: actorB, sideNo: 2, currentHp: 10, maxHp: 20 },
      ],
    } as BattleState;
    const resolvePlayerTurn = vi
      .fn()
      .mockResolvedValueOnce(ok({ state: pvpState, events: [], replayed: false, pending: true }))
      .mockResolvedValueOnce(
        ok({ state: { ...pvpState, version: 5 }, events: [], replayed: false }),
      );
    const deps = {
      players: {
        resolvePlayer: vi.fn(async ({ externalId }: { readonly externalId: string }) =>
          ok({
            playerId: externalId === "b" ? playerB : playerId,
            state: "COMPLETE",
            created: false,
          }),
        ),
      },
      activeBattleId: vi.fn(async () => battleId),
      battle: { currentState: vi.fn(async () => ok(pvpState)), resolvePlayerTurn },
      controllers: {
        listByBattle: vi.fn(async () => [
          {
            participantId,
            battleId,
            kind: "PLAYER" as const,
            playerId,
            adminPrincipalId: null,
            revision: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            participantId: actorB,
            battleId,
            kind: "PLAYER" as const,
            playerId: playerB,
            adminPrincipalId: null,
            revision: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
        transition: vi.fn(),
      },
      admins: { resolvePrincipal: vi.fn(async () => null) },
    } as unknown as PveSceneDependencies;
    const resolver = createPveSceneConversationResolver(deps);

    await expect(
      resolver.resolve(context("/movimento 1", { idempotencyKey: "a" })),
    ).resolves.toEqual(ok({ resultRefType: "BATTLE", resultRefId: battleId, outgoing: [] }));
    const second = await resolver.resolve(
      context("/movimento 1", { senderRef: "b", idempotencyKey: "b" }),
    );

    expect(resolvePlayerTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        playerId,
        action: expect.objectContaining({
          actorParticipantId: participantId,
          targetParticipantId: enemyId,
        }),
      }),
    );
    expect(resolvePlayerTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        playerId: playerB,
        action: expect.objectContaining({
          actorParticipantId: actorB,
          targetParticipantId: participantId,
        }),
      }),
    );
    if (!second.ok || second.value === null) throw new Error("Expected PVP resolution reply");
    expect(second.value.outgoing).toHaveLength(1);
  });

  it("lets a PVP participant surrender once with a compact terminal reply", async () => {
    const surrendered = {
      ...state,
      battleType: "PVP" as const,
      status: "LOST" as const,
      version: 5,
    } as BattleState;
    const surrenderPvp = vi.fn(async () => ok({ state: surrendered, events: [], replayed: false }));
    const setup = dependencies(false);
    const deps = {
      ...setup.dependencies,
      battle: {
        currentState: vi.fn(async () => ok({ ...state, battleType: "PVP" as const })),
        resolvePlayerTurn: setup.resolvePlayerTurn,
        surrenderPvp,
      },
    } as unknown as PveSceneDependencies;

    const result = await createPveSceneConversationResolver(deps).resolve(context("/desistir"));

    expect(surrenderPvp).toHaveBeenCalledWith(
      expect.objectContaining({ battleId, playerId, expectedVersion: state.version }),
    );
    expect(result.ok && result.value?.outgoing[0]?.payload.text).toContain("desistiu");
  });

  it("accepts prose with its final directive and remains silent while an ally is pending", async () => {
    const setup = dependencies(true);
    const result = await createPveSceneConversationResolver(setup.dependencies).resolve(
      context("Eu cubro a frente.\n/movimento 1"),
    );
    expect(result).toEqual(ok({ resultRefType: "BATTLE", resultRefId: battleId, outgoing: [] }));
    expect(setup.resolvePlayerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        battleId,
        playerId,
        action: {
          type: "USE_MOVE",
          actorParticipantId: participantId,
          targetParticipantId: enemyId,
          moveSlot: 1,
        },
      }),
    );
  });

  it("returns one compact result only after the turn resolves and renders a compact PVE HUD", async () => {
    const setup = dependencies(false);
    const routes = createPveSceneRoutes(setup.dependencies);
    const action = await routeFor(routes, "movimento").handler.handle(context("/movimento 1"));
    expect(action.ok && action.value.outgoing).toHaveLength(1);
    const hud = await routeFor(routes, "batalha").handler.handle(context("/batalha"));
    expect(hud.ok && hud.value.outgoing[0]?.payload.text).toContain("Turno 3");
    expect(hud.ok && hud.value.outgoing[0]?.payload.text).toContain("HP 12/20");
  });

  it("rejects a directive that is not final with a compact validation error", async () => {
    const setup = dependencies(false);
    const result = await createPveSceneConversationResolver(setup.dependencies).resolve(
      context("/movimento 1\nmas espero."),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Use uma única diretiva / na última linha.");
  });

  it("lets an authorized narrator submit, assume, and restore automatic control", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    const narrator = {
      participantId,
      battleId,
      kind: "NARRATOR" as const,
      playerId: null,
      adminPrincipalId: principalId,
      revision: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setup.listByBattle.mockResolvedValue([narrator]);
    setup.resolvePrincipal.mockResolvedValue({ principalId });
    const routes = createPveSceneRoutes(setup.dependencies);
    await routeFor(routes, "movimento").handler.handle(context("/movimento 1"));
    expect(setup.resolvePlayerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: null, adminPrincipalId: principalId }),
    );

    const auto = { ...narrator, kind: "AUTO" as const, adminPrincipalId: null, revision: 3 };
    setup.listByBattle.mockResolvedValue([auto]);
    await routeFor(routes, "assumir").handler.handle(context("/assumir"));
    expect(setup.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ participantId, kind: "NARRATOR", adminPrincipalId: principalId }),
    );
    setup.listByBattle.mockResolvedValue([narrator]);
    await routeFor(routes, "automatico").handler.handle(context("/automatico"));
    expect(setup.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ participantId, kind: "AUTO", adminPrincipalId: null }),
    );
  });
});
