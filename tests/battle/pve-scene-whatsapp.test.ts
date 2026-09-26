import { describe, expect, it, vi } from "vitest";
import type { BattleEvent, BattleState } from "../../src/modules/battle/contracts.js";
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
const releaseId = "77777777-7777-4777-8777-777777777777";
const pikachuSpecies = "88888888-8888-4888-8888-888888888888";
const rattataSpecies = "99999999-9999-4999-8999-999999999999";
const quickAttackId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const state = {
  battleId,
  battleType: "WILD",
  status: "ACTIVE",
  contentReleaseId: releaseId,
  version: 4,
  turnNumber: 3,
  sides: [
    {
      sideNo: 1,
      controllerKind: "PLAYER",
      playerId,
      participantIds: [participantId],
      activeParticipantId: participantId,
      result: null,
    },
    {
      sideNo: 2,
      controllerKind: "WILD",
      playerId: null,
      participantIds: [enemyId],
      activeParticipantId: enemyId,
      result: null,
    },
  ],
  combatants: [
    {
      participantId,
      participantKind: "PLAYER_POKEMON",
      sideNo: 1,
      speciesId: pikachuSpecies,
      currentHp: 12,
      maxHp: 20,
      moves: [{ slotNo: 1, moveId: quickAttackId }],
      majorStatus: null,
    },
    {
      participantId: enemyId,
      participantKind: "WILD_POKEMON",
      sideNo: 2,
      rosterPosition: 1,
      speciesId: rattataSpecies,
      currentHp: 10,
      maxHp: 20,
      moves: [],
      majorStatus: null,
    },
  ],
} as unknown as BattleState;

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

function presentation() {
  return {
    speciesDisplayName: vi.fn(
      async (_releaseId: string, speciesId: string): Promise<string | null> =>
        speciesId === pikachuSpecies ? "Pikachu" : speciesId === rattataSpecies ? "Rattata" : null,
    ),
    moveDisplayNames: vi.fn(
      async (_releaseId: string, moveIds: readonly string[]) =>
        new Map(moveIds.map((id) => [id, id === quickAttackId ? "Quick Attack" : "Move"])),
    ),
  };
}

function dependencies(pending: boolean) {
  const resolvePlayerTurn = vi.fn(async () =>
    ok({
      state,
      events: [] as BattleEvent[],
      replayed: false,
      ...(pending ? { pending: true } : {}),
    }),
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
      controllers: { listByBattle, transition },
      presentation: presentation(),
      admins: { resolvePrincipal },
    } as unknown as PveSceneDependencies,
  };
}

function routeFor(routes: ReturnType<typeof createPveSceneRoutes>, command: string) {
  const route = routes.find((entry) => entry.command === command);
  if (route === undefined) throw new Error(`Missing ${command} route`);
  return route;
}

describe("PVE/PVP WhatsApp scene actions", () => {
  it("admits combat actions embedded in scene messages for PVE and PVP groups", () => {
    const setup = dependencies(false);
    const route = routeFor(createPveSceneRoutes(setup.dependencies), "movimento");
    expect(route.allowEmbedded).toBe(true);
    expect(route.policy).toMatchObject({
      requiredAnyGroupCapabilities: ["pve", "pvp"],
      requiresMechanicalReady: true,
    });
  });

  it("accepts an inline move by name and reacts with ✅ while waiting for the other controller", async () => {
    const setup = dependencies(true);
    const result = await createPveSceneConversationResolver(setup.dependencies).resolve(
      context("Pikachu espera uma abertura. /movimento Quick Attack"),
    );

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
    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "BATTLE",
        resultRefId: battleId,
        outgoing: [
          {
            messageType: "REACTION",
            payload: { emoji: "✅", targetExternalMessageId: "message" },
          },
        ],
      },
    });
  });

  it("accepts a command before later prose and does not interpret the prose mechanically", async () => {
    const setup = dependencies(true);
    const result = await createPveSceneConversationResolver(setup.dependencies).resolve(
      context("/movimento 1\nPikachu então continua avançando pela lateral."),
    );
    expect(result.ok).toBe(true);
    expect(setup.resolvePlayerTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps each PVP action hidden, then sends one compact resolved turn with both mentions", async () => {
    const playerB = "55555555-5555-4555-8555-555555555555";
    const actorB = "66666666-6666-4666-8666-666666666666";
    const squirtleSpecies = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const waterGunId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const pvpState = {
      ...state,
      battleType: "PVP" as const,
      version: 4,
      sides: [
        {
          sideNo: 1,
          controllerKind: "PLAYER",
          playerId,
          participantIds: [participantId],
          activeParticipantId: participantId,
          result: null,
        },
        {
          sideNo: 2,
          controllerKind: "PLAYER",
          playerId: playerB,
          participantIds: [actorB],
          activeParticipantId: actorB,
          result: null,
        },
      ],
      combatants: [
        { ...state.combatants[0], currentHp: 17 },
        {
          ...state.combatants[1],
          participantId: actorB,
          participantKind: "PLAYER_POKEMON",
          speciesId: squirtleSpecies,
          currentHp: 14,
          sideNo: 2,
          moves: [{ slotNo: 1, moveId: waterGunId }],
        },
      ],
    } as unknown as BattleState;

    const resolvedState = { ...pvpState, version: 5, turnNumber: 4 } as BattleState;
    const events = [
      {
        type: "MoveUsed",
        payload: {
          participantId,
          targetParticipantId: actorB,
          moveId: quickAttackId,
          moveSlot: 1,
        },
      },
      {
        type: "DamageApplied",
        payload: {
          participantId: actorB,
          sourceParticipantId: participantId,
          moveId: quickAttackId,
          damage: 7,
          remainingHp: 14,
          effectivenessBasisPoints: 10_000,
        },
      },
      {
        type: "MoveUsed",
        payload: {
          participantId: actorB,
          targetParticipantId: participantId,
          moveId: waterGunId,
          moveSlot: 1,
        },
      },
      {
        type: "DamageApplied",
        payload: {
          participantId,
          sourceParticipantId: actorB,
          moveId: waterGunId,
          damage: 7,
          remainingHp: 17,
          effectivenessBasisPoints: 10_000,
        },
      },
    ];
    const resolvePlayerTurn = vi
      .fn()
      .mockResolvedValueOnce(ok({ state: pvpState, events: [], replayed: false, pending: true }))
      .mockResolvedValueOnce(ok({ state: resolvedState, events, replayed: false }));

    const present = presentation();
    present.speciesDisplayName.mockImplementation(async (_release, speciesId) => {
      if (speciesId === pikachuSpecies) return "Pikachu";
      if (speciesId === squirtleSpecies) return "Squirtle";
      return null;
    });
    present.moveDisplayNames.mockImplementation(
      async (_release, moveIds) =>
        new Map(
          moveIds.map((id) => [
            id,
            id === quickAttackId ? "Quick Attack" : id === waterGunId ? "Water Gun" : "Move",
          ]),
        ),
    );

    const deps = {
      players: {
        resolvePlayer: vi.fn(async ({ externalId }: { readonly externalId: string }) =>
          ok({ playerId: externalId === "b" ? playerB : playerId }),
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
      presentation: present,
      playerExternalRef: vi.fn(async (id: string) =>
        id === playerId ? "111@s.whatsapp.net" : "222@s.whatsapp.net",
      ),
      admins: { resolvePrincipal: vi.fn(async () => null) },
    } as unknown as PveSceneDependencies;

    const resolver = createPveSceneConversationResolver(deps);
    const first = await resolver.resolve(context("/movimento 1", { idempotencyKey: "a" }));
    expect(first.ok && first.value?.outgoing).toHaveLength(1);
    expect(first.ok && first.value?.outgoing[0]?.messageType).toBe("REACTION");

    const second = await resolver.resolve(
      context("/movimento 1", { senderRef: "b", idempotencyKey: "b" }),
    );
    if (!second.ok || second.value === null) throw new Error("Expected PVP resolution reply");
    expect(second.value.outgoing).toHaveLength(2);
    expect(second.value.outgoing[0]?.messageType).toBe("REACTION");
    const text = String(second.value.outgoing[1]?.payload.text);
    expect(text).toContain("⚔️ *Turno 4*");
    expect(text).toContain("Pikachu usou *Quick Attack*.");
    expect(text).toContain("Squirtle: 21 → 14 HP.");
    expect(text).toContain("Squirtle usou *Water Gun*.");
    expect(text).toContain("Pikachu: 24 → 17 HP.");
    expect(text).toContain("@111\nx\n@222");
    expect(second.value.outgoing[1]?.payload.mentions).toEqual([
      "111@s.whatsapp.net",
      "222@s.whatsapp.net",
    ]);
  });

  it("rejects a second action for the same open turn without reacting", async () => {
    const setup = dependencies(true);
    setup.resolvePlayerTurn.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "TURN_WINDOW_ALREADY_SUBMITTED",
        message: "already submitted",
      },
    } as never);
    const result = await createPveSceneConversationResolver(setup.dependencies).resolve(
      context("/movimento 1"),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        outgoing: [
          {
            messageType: "TEXT",
            payload: { text: "A ação deste turno já foi definida." },
          },
        ],
      },
    });
  });

  it("lets a PVP participant surrender once with a compact terminal reply and reaction", async () => {
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
    expect(result.ok && result.value?.outgoing[0]?.messageType).toBe("REACTION");
    expect(result.ok && result.value?.outgoing[1]?.payload.text).toContain("desistiu");
  });

  it("renders a battle HUD with usable move options", async () => {
    const setup = dependencies(false);
    const routes = createPveSceneRoutes(setup.dependencies);
    const hud = await routeFor(routes, "batalha").handler.handle(context("/batalha"));
    const text = String(hud.ok ? hud.value.outgoing[0]?.payload.text : "");
    expect(text).toContain("*BATALHA · Turno 3*");
    expect(text).toContain("◇ *SEU POKÉMON*");
    expect(text).toContain("HP `12/20`");
    expect(text).toContain("◇ *OPONENTE*");
    expect(text).toContain("`/combate` · comandos e regras");
    expect(text).toContain("Quick Attack");
    expect(text).toContain("`/movimento 1`");
  });

  it("lets an authorized narrator submit, assume, and restore automatic control", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    const narratorState = {
      ...state,
      combatants: state.combatants.map((combatant) =>
        combatant.participantId === enemyId
          ? {
              ...combatant,
              moves: [{ slotNo: 1, moveId: quickAttackId }],
            }
          : combatant,
      ),
    } as BattleState;
    const narratorDependencies = {
      ...setup.dependencies,
      battle: {
        ...setup.dependencies.battle,
        currentState: vi.fn(async () => ok(narratorState)),
      },
    } as unknown as PveSceneDependencies;
    const narrator = {
      participantId: enemyId,
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
    const routes = createPveSceneRoutes(narratorDependencies);

    await routeFor(routes, "movimento").handler.handle(context("/movimento 1"));
    expect(setup.resolvePlayerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: null, adminPrincipalId: principalId }),
    );

    const auto = { ...narrator, kind: "AUTO" as const, adminPrincipalId: null, revision: 3 };
    setup.listByBattle.mockResolvedValue([auto]);
    await routeFor(routes, "assumir").handler.handle(context("/assumir"));
    expect(setup.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        participantId: enemyId,
        kind: "NARRATOR",
        adminPrincipalId: principalId,
      }),
    );

    setup.listByBattle.mockResolvedValue([narrator]);
    await routeFor(routes, "automatico").handler.handle(context("/automatico"));
    expect(setup.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ participantId: enemyId, kind: "AUTO", adminPrincipalId: null }),
    );
  });
  it("resolves a failed capture as the player's PVE turn action", async () => {
    const setup = dependencies(false);
    const encounterId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const ballItemId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const resolvedState = { ...state, version: 5, turnNumber: 4 } as BattleState;
    setup.resolvePlayerTurn.mockResolvedValueOnce(
      ok({
        state: resolvedState,
        events: [
          {
            type: "ActionSkipped",
            payload: {
              participantId,
              targetParticipantId: enemyId,
              ballItemId,
              reason: "CAPTURE_FAILED",
            },
          },
          {
            type: "DamageApplied",
            payload: {
              participantId,
              sourceParticipantId: enemyId,
              damage: 2,
              remainingHp: 10,
            },
          },
        ],
        replayed: false,
      }),
    );
    const attempt = vi.fn(async () =>
      ok({
        captureAttemptId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        encounterId,
        battleId,
        status: "FAILED" as const,
        probabilityBasisPoints: 2500,
        rollBasisPoints: 9000,
        pokemonInstanceId: null,
        placement: null,
        events: [],
        replayed: false,
      }),
    );
    const deps = {
      ...setup.dependencies,
      encounters: {
        activeForPlayer: vi.fn(async () =>
          ok({
            encounterId,
            battleId,
            contentReleaseId: releaseId,
            revision: 7n,
          }),
        ),
      },
      captureBalls: {
        listAvailable: vi.fn(async () => [
          { itemId: ballItemId, displayName: "Poké Ball", quantity: 3n },
        ]),
      },
      capture: { attempt },
    } as unknown as PveSceneDependencies;

    const result = await createPveSceneConversationResolver(deps).resolve({
      ...context("/capturar Poke Ball"),
      correlationId: "12121212-1212-4121-8121-121212121212",
    });

    expect(attempt).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId,
        encounterId,
        expectedBattleVersion: state.version,
        actorParticipantId: participantId,
        targetWildNo: 1,
        ballItemId,
      }),
    );
    expect(setup.resolvePlayerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        battleId,
        playerId,
        expectedVersion: state.version,
        action: {
          type: "CAPTURE_ATTEMPT",
          actorParticipantId: participantId,
          ballItemId,
          targetParticipantId: enemyId,
        },
      }),
    );
    if (!result.ok || result.value === null) throw new Error("Expected failed capture turn reply");
    expect(String(result.value.outgoing[1]?.payload.text)).toContain("A Poké Ball foi lançada.");
    expect(String(result.value.outgoing[1]?.payload.text)).toContain("O Pokémon escapou.");
    expect(String(result.value.outgoing[1]?.payload.text)).toContain("12 → 10 HP.");
  });
  it("does not expose the unsupported /item battle command", () => {
    const setup = dependencies(false);
    const routes = createPveSceneRoutes(setup.dependencies);
    expect(routes.some((route) => route.command === "item")).toBe(false);
  });
});
