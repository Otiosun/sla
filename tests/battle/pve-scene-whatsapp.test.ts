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
      moves: [{ slotNo: 1, moveId: quickAttackId, ppCurrent: 24, maxPp: 30 }],
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
  input: {
    readonly senderRef?: string;
    readonly idempotencyKey?: string;
    readonly replyToExternalMessageId?: string | null;
    readonly mentions?: readonly string[];
  } = {},
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
      ...(input.mentions === undefined ? {} : { mentions: [...input.mentions] }),
      mediaRefs: [],
      replyToExternalMessageId: input.replyToExternalMessageId ?? null,
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
  const transition = vi.fn(
    async (input: {
      readonly participantId: string;
      readonly expectedRevision: number;
      readonly kind: "NARRATOR" | "AUTO";
      readonly adminPrincipalId: string | null;
    }): Promise<BattleParticipantController> => ({
      participantId: input.participantId,
      battleId,
      kind: input.kind,
      playerId: null,
      adminPrincipalId: input.adminPrincipalId,
      revision: input.expectedRevision + 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
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
    expect(text).toContain("◇ *𝗧𝗨𝗥𝗡𝗢 04*");
    expect(text).toContain("@111 × @222");
    expect(text).toContain("Pikachu usou *Quick Attack*.");
    expect(text).toContain("Squirtle · HP `21 → 14`");
    expect(text).toContain("Squirtle usou *Water Gun*.");
    expect(text).toContain("Pikachu · HP `24 → 17`");
    expect(text).not.toContain("@111\nx\n@222");
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

  it("renders a compact battle HUD without dumping moves", async () => {
    const setup = dependencies(false);
    const routes = createPveSceneRoutes(setup.dependencies);
    const hud = await routeFor(routes, "batalha").handler.handle(context("/batalha"));
    const text = String(hud.ok ? hud.value.outgoing[0]?.payload.text : "");
    expect(text).toContain("◇ *𝗕𝗔𝗧𝗔𝗟𝗛𝗔*");
    expect(text).toContain("Turno `03`");
    expect(text).toContain("*Pikachu*");
    expect(text).toContain("HP `12 / 20`");
    expect(text).toContain("*Rattata*");
    expect(text).toContain("`/moves`");
    expect(text).not.toContain("Quick Attack");
    expect(text).not.toContain("*Golpes*");
    expect(hud.ok && hud.value.outgoing[0]?.payload.mentions).toEqual(["sender"]);
  });

  it("shows only the caller's own turn submission state in /batalha", async () => {
    const setup = dependencies(false);
    const submittedDeps = {
      ...setup.dependencies,
      turnWindowForBattleVersion: vi.fn(async () => ({
        window: {
          requiredControllers: [{ participantId }],
          requiredPlayers: [],
        },
        submissions: [
          {
            status: "ACTIVE",
            playerId,
            action: { actorParticipantId: participantId },
          },
        ],
      })),
    } as unknown as PveSceneDependencies;
    const submitted = await routeFor(createPveSceneRoutes(submittedDeps), "batalha").handler.handle(
      context("/batalha"),
    );
    expect(submitted.ok && String(submitted.value.outgoing[0]?.payload.text)).toContain(
      "〔✓〕 Sua ação já foi definida.",
    );

    const pendingDeps = {
      ...setup.dependencies,
      turnWindowForBattleVersion: vi.fn(async () => ({
        window: {
          requiredControllers: [{ participantId }],
          requiredPlayers: [],
        },
        submissions: [],
      })),
    } as unknown as PveSceneDependencies;
    const pending = await routeFor(createPveSceneRoutes(pendingDeps), "batalha").handler.handle(
      context("/batalha"),
    );
    expect(pending.ok && String(pending.value.outgoing[0]?.payload.text)).toContain(
      "Sua ação ainda não foi definida.",
    );
  });

  it("does not let a player inspect another player's hidden PVP submission state by mentioning them", async () => {
    const setup = dependencies(false);
    const opponentPlayerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const opponentParticipantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const opponentRef = "opponent@s.whatsapp.net";
    const pvpState = {
      ...state,
      battleType: "PVP",
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
          playerId: opponentPlayerId,
          participantIds: [opponentParticipantId],
          activeParticipantId: opponentParticipantId,
          result: null,
        },
      ],
      combatants: [
        state.combatants[0],
        {
          ...state.combatants[1],
          participantId: opponentParticipantId,
          participantKind: "PLAYER_POKEMON",
        },
      ],
    } as unknown as BattleState;
    const controllers: readonly BattleParticipantController[] = [
      {
        participantId,
        battleId,
        kind: "PLAYER",
        playerId,
        adminPrincipalId: null,
        revision: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        participantId: opponentParticipantId,
        battleId,
        kind: "PLAYER",
        playerId: opponentPlayerId,
        adminPrincipalId: null,
        revision: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const deps = {
      ...setup.dependencies,
      players: {
        resolvePlayer: vi.fn(async ({ externalId }: { readonly externalId: string }) =>
          ok({ playerId: externalId === opponentRef ? opponentPlayerId : playerId }),
        ),
      },
      activeBattleId: vi.fn(async () => battleId),
      battle: {
        ...setup.dependencies.battle,
        currentState: vi.fn(async () => ok(pvpState)),
      },
      controllers: {
        ...setup.dependencies.controllers,
        listByBattle: vi.fn(async () => controllers),
      },
      turnWindowForBattleVersion: vi.fn(async () => ({
        window: {
          requiredControllers: [
            { participantId, playerId, kind: "PLAYER" },
            {
              participantId: opponentParticipantId,
              playerId: opponentPlayerId,
              kind: "PLAYER",
            },
          ],
          requiredPlayers: [],
        },
        submissions: [
          {
            status: "ACTIVE",
            playerId: opponentPlayerId,
            action: { actorParticipantId: opponentParticipantId },
          },
        ],
      })),
    } as unknown as PveSceneDependencies;

    const result = await routeFor(createPveSceneRoutes(deps), "batalha").handler.handle(
      context("/batalha @opponent", { mentions: [opponentRef] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("Sua ação ainda não foi definida.");
    expect(text).not.toContain("〔✓〕 Sua ação já foi definida.");
    expect(result.value.outgoing[0]?.payload.mentions).toEqual(["sender"]);
  });

  it("does not expose a targeted player's hidden PVP submission state to an admin caller", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    const targetRef = "target@s.whatsapp.net";
    const opponentPlayerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const opponentParticipantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const pvpState = {
      ...state,
      battleType: "PVP",
      sides: [
        state.sides[0],
        {
          sideNo: 2,
          controllerKind: "PLAYER",
          playerId: opponentPlayerId,
          participantIds: [opponentParticipantId],
          activeParticipantId: opponentParticipantId,
          result: null,
        },
      ],
      combatants: [
        state.combatants[0],
        {
          ...state.combatants[1],
          participantId: opponentParticipantId,
          participantKind: "PLAYER_POKEMON",
        },
      ],
    } as unknown as BattleState;
    setup.resolvePrincipal.mockResolvedValue({ principalId });
    const deps = {
      ...setup.dependencies,
      players: {
        resolvePlayer: vi.fn(async ({ externalId }: { readonly externalId: string }) =>
          externalId === targetRef
            ? ok({ playerId })
            : ({
                ok: false as const,
                error: { code: "NOT_FOUND", message: "not a player" },
              } as never),
        ),
      },
      activeBattleId: vi.fn(async () => battleId),
      battle: {
        ...setup.dependencies.battle,
        currentState: vi.fn(async () => ok(pvpState)),
      },
      turnWindowForBattleVersion: vi.fn(async () => ({
        window: {
          requiredControllers: [{ participantId, playerId, kind: "PLAYER" }],
          requiredPlayers: [],
        },
        submissions: [
          {
            status: "ACTIVE",
            playerId,
            action: { actorParticipantId: participantId },
          },
        ],
      })),
    } as unknown as PveSceneDependencies;

    const result = await routeFor(createPveSceneRoutes(deps), "batalha").handler.handle(
      context("/batalha @target", { senderRef: "narrator", mentions: [targetRef] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text ?? "");
    expect(text).not.toContain("〔✓〕 Sua ação já foi definida.");
    expect(text).not.toContain("Sua ação ainda não foi definida.");
  });

  it("shows current battle moves privately and only reacts in the source chat", async () => {
    const setup = dependencies(false);
    const result = await routeFor(createPveSceneRoutes(setup.dependencies), "moves").handler.handle(
      context("/moves"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]).toMatchObject({
      messageType: "REACTION",
      payload: { emoji: "✅" },
    });
    expect(result.value.outgoing[1]?.destinationRef).toBe("sender");
    const text = String(result.value.outgoing[1]?.payload.text ?? "");
    expect(text).toContain("◇ *𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢𝗦*");
    expect(text).toContain("Quick Attack");
    expect(text).toContain("PP `24 / 30`");
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
      narratorBattleId: vi.fn(async () => battleId),
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
    const assumed = await routeFor(routes, "assumir").handler.handle(
      context("/assumir @target", { mentions: ["target@s.whatsapp.net"], senderRef: "narrator" }),
    );
    expect(setup.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        participantId: enemyId,
        kind: "NARRATOR",
        adminPrincipalId: principalId,
      }),
    );
    const assumedText = String(assumed.ok ? assumed.value.outgoing[0]?.payload.text : "");
    expect(assumedText).toContain("𝗖𝗢𝗡𝗧𝗥𝗢𝗟𝗘 𝗗𝗢 𝗡𝗔𝗥𝗥𝗔𝗗𝗢𝗥");
    expect(assumedText).toContain("`/moves @target`");
    expect(assumedText).not.toContain("Quick Attack");

    setup.listByBattle.mockResolvedValue([narrator]);
    await routeFor(routes, "automatico").handler.handle(context("/automatico"));
    expect(setup.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ participantId: enemyId, kind: "AUTO", adminPrincipalId: null }),
    );
  });
  it("lets a narrator act through a persisted NARRATOR controller without a player account", async () => {
    const setup = dependencies(true);
    const principalId = "55555555-5555-4555-8555-555555555555";
    const narratorState = {
      ...state,
      combatants: state.combatants.map((combatant) =>
        combatant.participantId === enemyId
          ? { ...combatant, moves: [{ slotNo: 1, moveId: quickAttackId }] }
          : combatant,
      ),
    } as BattleState;
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

    const deps = {
      ...setup.dependencies,
      players: {
        resolvePlayer: vi.fn(async () => ({
          ok: false as const,
          error: { code: "NOT_FOUND", message: "not a player" },
        })),
      },
      narratorBattleId: vi.fn(async () => battleId),
      battle: {
        ...setup.dependencies.battle,
        currentState: vi.fn(async () => ok(narratorState)),
      },
    } as unknown as PveSceneDependencies;

    const result = await createPveSceneConversationResolver(deps).resolve(
      context("*Poochyena avança.*\n/movimento 1", { senderRef: "narrator" }),
    );

    expect(result.ok).toBe(true);
    expect(setup.resolvePlayerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        battleId,
        playerId: null,
        adminPrincipalId: principalId,
      }),
    );
  });

  it("lets a controller-backed narrator inspect the wild HUD without owning a player account", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    const narratorState = {
      ...state,
      combatants: state.combatants.map((combatant) =>
        combatant.participantId === enemyId
          ? {
              ...combatant,
              moves: [{ slotNo: 1, moveId: quickAttackId, ppCurrent: 30, maxPp: 30 }],
            }
          : combatant,
      ),
    } as BattleState;
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

    const deps = {
      ...setup.dependencies,
      players: {
        resolvePlayer: vi.fn(async () => ({
          ok: false as const,
          error: { code: "NOT_FOUND", message: "not a player" },
        })),
      },
      narratorBattleId: vi.fn(async () => battleId),
      battle: {
        ...setup.dependencies.battle,
        currentState: vi.fn(async () => ok(narratorState)),
      },
    } as unknown as PveSceneDependencies;

    const hud = await routeFor(createPveSceneRoutes(deps), "batalha").handler.handle(
      context("/batalha", { senderRef: "narrator@s.whatsapp.net" }),
    );

    expect(hud.ok).toBe(true);
    if (!hud.ok) return;
    const text = String(hud.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("*Rattata*");
    expect(text).toContain("*Rattata*");
    expect(text).toContain("O selvagem está sob seu controle");
    expect(text).toContain("`/moves`");
    expect(text).not.toContain("Quick Attack");
    expect(text).not.toContain("`/capturar`");
  });

  it("lets /assumir explicitly target another trainer battle", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    const targetRef = "target@s.whatsapp.net";
    const auto = {
      participantId: enemyId,
      battleId,
      kind: "AUTO" as const,
      playerId: null,
      adminPrincipalId: null,
      revision: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setup.listByBattle.mockResolvedValue([auto]);
    setup.resolvePrincipal.mockResolvedValue({ principalId });

    const routes = createPveSceneRoutes(setup.dependencies);
    const base = context("/assumir @target", { senderRef: "narrator" });
    const result = await routeFor(routes, "assumir").handler.handle({
      ...base,
      message: { ...base.message, mentions: [targetRef] },
    });

    expect(setup.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        participantId: enemyId,
        kind: "NARRATOR",
        adminPrincipalId: principalId,
      }),
    );
    expect(result.ok && result.value.outgoing[0]?.payload.mentions).toEqual([targetRef]);
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
    expect(String(result.value.outgoing[1]?.payload.text)).toContain("HP `12 → 10`");
  });
  it("starts a presented encounter from the player's first move with PLAYER initiative", async () => {
    const setup = dependencies(true);
    const encounterId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const startCanonical = vi.fn(async () =>
      ok({
        start: { battleId },
        initialization: { state, replayed: false },
      }),
    );
    const deps = {
      ...setup.dependencies,
      activeBattleId: vi.fn(async () => null),
      encounters: {
        activeForPlayer: vi.fn(async () =>
          ok({
            encounterId,
            playerId,
            status: "PRESENTED",
            contentReleaseId: releaseId,
            revision: 2n,
            battleId: null,
            snapshot: {
              speciesId: rattataSpecies,
              level: 5,
              shiny: false,
              moves: [],
            },
          }),
        ),
      },
      battleStart: { startCanonical },
      roster: {
        listTeam: vi.fn(async () => [
          {
            pokemonInstanceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            displayName: "Pikachu",
            level: 5,
            currentHp: 12,
            slotNo: 1,
          },
        ]),
        teamPokemonDetail: vi.fn(async () => ({
          displayName: "Pikachu",
          nickname: null,
          moves: [
            {
              slotNo: 1,
              displayName: "Quick Attack",
              ppCurrent: 30,
              maxPp: 30,
            },
          ],
        })),
      },
    } as unknown as PveSceneDependencies;

    const result = await createPveSceneConversationResolver(deps).resolve(
      context("Pikachu avança. /movimento Quick Attack"),
    );

    expect(startCanonical).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId,
        encounterId,
        firstTurnInitiative: "PLAYER",
      }),
    );
    expect(setup.resolvePlayerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ battleId, playerId }),
    );
    expect(result.ok && result.value?.outgoing[0]?.messageType).toBe("REACTION");
  });

  it("does not create a battle when the player's first move is invalid", async () => {
    const setup = dependencies(true);
    const encounterId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const startCanonical = vi.fn();
    const deps = {
      ...setup.dependencies,
      activeBattleId: vi.fn(async () => null),
      encounters: {
        activeForPlayer: vi.fn(async () =>
          ok({
            encounterId,
            playerId,
            status: "PRESENTED",
            contentReleaseId: releaseId,
            revision: 2n,
            battleId: null,
            snapshot: { speciesId: rattataSpecies, level: 5, shiny: false, moves: [] },
          }),
        ),
      },
      battleStart: { startCanonical },
      roster: {
        listTeam: vi.fn(async () => [
          {
            pokemonInstanceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            displayName: "Pikachu",
            level: 5,
            currentHp: 12,
            slotNo: 1,
          },
        ]),
        teamPokemonDetail: vi.fn(async () => ({
          displayName: "Pikachu",
          nickname: null,
          moves: [{ slotNo: 1, displayName: "Quick Attack", ppCurrent: 30, maxPp: 30 }],
        })),
      },
    } as unknown as PveSceneDependencies;

    const result = await createPveSceneConversationResolver(deps).resolve(
      context("/movimento Thunderbolt"),
    );

    expect(result.ok).toBe(false);
    expect(startCanonical).not.toHaveBeenCalled();
  });

  it("uses an encounter reply for the narrator's first move even when another battle is controlled", async () => {
    const setup = dependencies(true);
    const principalId = "55555555-5555-4555-8555-555555555555";
    const targetRef = "target@s.whatsapp.net";
    const encounterId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const otherBattleId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const wildState = {
      ...state,
      combatants: state.combatants.map((combatant) =>
        combatant.participantId === enemyId
          ? {
              ...combatant,
              moves: [{ slotNo: 1, moveId: quickAttackId, ppCurrent: 30, maxPp: 30 }],
            }
          : combatant,
      ),
    } as BattleState;
    const auto: BattleParticipantController = {
      participantId: enemyId,
      battleId,
      kind: "AUTO",
      playerId: null,
      adminPrincipalId: null,
      revision: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const narrator: BattleParticipantController = {
      ...auto,
      kind: "NARRATOR",
      adminPrincipalId: principalId,
      revision: 1,
    };
    setup.resolvePrincipal.mockResolvedValue({ principalId });
    setup.listByBattle.mockResolvedValueOnce([auto]).mockResolvedValue([narrator]);
    setup.transition.mockResolvedValue(narrator);
    const startCanonical = vi.fn(async () =>
      ok({ start: { battleId }, initialization: { state: wildState, replayed: false } }),
    );
    const deps = {
      ...setup.dependencies,
      players: {
        resolvePlayer: vi.fn(async ({ externalId }: { readonly externalId: string }) =>
          externalId === targetRef
            ? ok({ playerId })
            : ({
                ok: false as const,
                error: { code: "NOT_FOUND", message: "not a player" },
              } as never),
        ),
      },
      activeBattleId: vi.fn(async () => null),
      narratorBattleIds: vi.fn(async () => [otherBattleId]),
      replyContext: {
        resolve: vi.fn(async () => ({
          resultRefType: "ENCOUNTER",
          resultRefId: encounterId,
          mentions: [targetRef],
        })),
      },
      encounters: {
        activeForPlayer: vi.fn(async () =>
          ok({
            encounterId,
            playerId,
            status: "PRESENTED",
            contentReleaseId: releaseId,
            revision: 2n,
            battleId: null,
            snapshot: {
              speciesId: rattataSpecies,
              level: 5,
              shiny: false,
              moves: [{ moveId: quickAttackId, ppCurrent: 30 }],
            },
          }),
        ),
      },
      battleStart: { startCanonical },
      battle: {
        ...setup.dependencies.battle,
        currentState: vi.fn(async () => ok(wildState)),
      },
    } as unknown as PveSceneDependencies;

    const result = await createPveSceneConversationResolver(deps).resolve(
      context("Poochyena avança. /movimento Quick Attack", {
        senderRef: "narrator",
        replyToExternalMessageId: "spawn-message",
      }),
    );

    expect(startCanonical).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId,
        encounterId,
        firstTurnInitiative: "WILD",
      }),
    );
    expect(setup.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        participantId: enemyId,
        kind: "NARRATOR",
        adminPrincipalId: principalId,
      }),
    );
    expect(setup.resolvePlayerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        battleId,
        playerId: null,
        adminPrincipalId: principalId,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not fall back to an unrelated controlled battle when a narrator types a non-native @ target in PV", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    setup.resolvePrincipal.mockResolvedValue({ principalId });
    const currentState = vi.fn(async () => ok(state));
    const deps = {
      ...setup.dependencies,
      players: {
        resolvePlayer: vi.fn(async () => ({
          ok: false as const,
          error: { code: "NOT_FOUND", message: "not a player" },
        })),
      },
      narratorBattleIds: vi.fn(async () => [battleId]),
      battle: {
        ...setup.dependencies.battle,
        currentState,
      },
    } as unknown as PveSceneDependencies;

    const result = await routeFor(createPveSceneRoutes(deps), "moves").handler.handle(
      context("/moves @target", {
        senderRef: "narrator@s.whatsapp.net",
        mentions: [],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.userMessage).toContain("No PV");
    expect(currentState).not.toHaveBeenCalled();
  });

  it("still resolves narrator /moves through a real WhatsApp mention instead of a controlled battle", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    const targetRef = "target@s.whatsapp.net";
    setup.resolvePrincipal.mockResolvedValue({ principalId });
    const currentState = vi.fn(async () => ok(state));
    const deps = {
      ...setup.dependencies,
      players: {
        resolvePlayer: vi.fn(async ({ externalId }: { readonly externalId: string }) =>
          externalId === targetRef
            ? ok({ playerId })
            : ({
                ok: false as const,
                error: { code: "NOT_FOUND", message: "not a player" },
              } as never),
        ),
      },
      activeBattleId: vi.fn(async () => battleId),
      narratorBattleIds: vi.fn(async () => ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]),
      battle: {
        ...setup.dependencies.battle,
        currentState,
      },
    } as unknown as PveSceneDependencies;

    const result = await routeFor(createPveSceneRoutes(deps), "moves").handler.handle(
      context("/moves @target", {
        senderRef: "narrator@s.whatsapp.net",
        mentions: [targetRef],
      }),
    );

    expect(result.ok).toBe(true);
    expect(currentState).toHaveBeenCalledWith(battleId);
  });

  it("does not let text-only /automatico target an unrelated sole narrator battle", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    setup.resolvePrincipal.mockResolvedValue({ principalId });
    const deps = {
      ...setup.dependencies,
      narratorBattleIds: vi.fn(async () => [battleId]),
    } as unknown as PveSceneDependencies;

    const result = await routeFor(createPveSceneRoutes(deps), "automatico").handler.handle(
      context("/automatico @target", {
        senderRef: "narrator@s.whatsapp.net",
        mentions: [],
      }),
    );

    expect(result.ok).toBe(false);
    expect(setup.transition).not.toHaveBeenCalled();
  });

  it("does not reuse another narrator battle when a typed target is not a native mention", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    setup.resolvePrincipal.mockResolvedValue({ principalId });
    const narratorBattleIds = vi.fn(async () => [battleId]);
    const deps = {
      ...setup.dependencies,
      narratorBattleIds,
    } as unknown as PveSceneDependencies;

    const result = await routeFor(createPveSceneRoutes(deps), "moves").handler.handle(
      context("/moves @target", { senderRef: "narrator@s.whatsapp.net" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(narratorBattleIds).not.toHaveBeenCalled();
    expect(result.value.outgoing[0]?.messageType).toBe("REACTION");
    expect(result.value.outgoing[1]?.destinationRef).toBe("narrator@s.whatsapp.net");
    expect(String(result.value.outgoing[1]?.payload.text)).toContain("𝗔𝗟𝗩𝗢 𝗡Ã𝗢 𝗜𝗗𝗘𝗡𝗧𝗜𝗙𝗜𝗖𝗔𝗗𝗢");
  });

  it("does not guess when a narrator has multiple controlled battles", async () => {
    const setup = dependencies(false);
    const principalId = "55555555-5555-4555-8555-555555555555";
    setup.resolvePrincipal.mockResolvedValue({ principalId });
    const secondBattle = "66666666-6666-4666-8666-666666666666";
    const deps = {
      ...setup.dependencies,
      narratorBattleIds: vi.fn(async () => [battleId, secondBattle]),
      battle: {
        ...setup.dependencies.battle,
        currentState: vi.fn(async (id: string) => ok({ ...state, battleId: id })),
      },
      playerExternalRef: vi.fn(async () => "target@s.whatsapp.net"),
    } as unknown as PveSceneDependencies;

    const result = await routeFor(createPveSceneRoutes(deps), "batalha").handler.handle(
      context("/batalha", { senderRef: "narrator" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.messageType).toBe("REACTION");
    expect(result.value.outgoing[1]?.destinationRef).toBe("narrator");
    expect(String(result.value.outgoing[1]?.payload.text)).toContain("𝗕𝗔𝗧𝗔𝗟𝗛𝗔𝗦 𝗘𝗠 𝗔𝗡𝗗𝗔𝗠𝗘𝗡𝗧𝗢");
  });

  it("does not expose the unsupported /item battle command", () => {
    const setup = dependencies(false);
    const routes = createPveSceneRoutes(setup.dependencies);
    expect(routes.some((route) => route.command === "item")).toBe(false);
  });
});
