import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import type { WorldServiceWhatsAppDependencies } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

function context(): MessageHandlerContext {
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: `inbox:baileys:${randomUUID()}`,
    message: {
      provider: "baileys",
      externalMessageId: randomUUID(),
      senderRef: "5511999999999",
      chatRef: "120363000000000000@g.us",
      occurredAt: "2026-09-07T12:00:00-03:00",
      text: "/curar",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function activeCenterSession(
  playerId: ReturnType<typeof createPlayerId>,
): WorldServiceSessionRecord {
  const now = new Date("2026-09-07T15:00:00.000Z");
  return {
    sessionId: randomUUID(),
    playerId,
    areaId: randomUUID(),
    serviceKind: "POKEMON_CENTER",
    state: "OPEN",
    sceneProofId: randomUUID(),
    expectedReplyOutboxIdempotencyKey: null,
    expectedReplyExternalMessageId: null,
    revision: 2n,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}

function routeFor(dependencies: WorldServiceWhatsAppDependencies, command: string) {
  // Legacy unit stubs intentionally omit world.getLocation. Add a no-op
  // implementation rather than weakening production travel/battle guards.
  const completeDependencies: WorldServiceWhatsAppDependencies = {
    ...dependencies,
    world: dependencies.world ?? {
      getLocation: async () => { throw new Error("Unexpected location lookup in unit fixture"); },
    },
  };
  const route = createWorldServiceWhatsAppRoutes(completeDependencies).find(
    (candidate) => candidate.command === command,
  );
  if (route === undefined) throw new Error(`Missing route: ${command}`);
  return route;
}

describe("Pokemon Center WhatsApp healing", () => {
  it("commits healing through the mechanical service before rendering success", async () => {
    const playerId = createPlayerId();
    const session = activeCenterSession(playerId);
    const healTeam = vi.fn(async () =>
      ok({
        healedPokemonCount: 2,
        hpRestoredPokemonCount: 1,
        ppRestoredSlots: 3,
        statusesCleared: 1,
        replayed: false,
      }),
    );
    const dependencies = {
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE" as const, created: false }),
      },
      world: {
        getLocation: async () => {
          throw new Error("heal route must not reopen or relocate the player");
        },
      },
      sessions: {
        openVisit: async () => {
          throw new Error("heal route must not open a second visit");
        },
        loadActiveSession: async () => ok(session),
        closeVisit: async () => {
          throw new Error("heal route must not close the visit");
        },
      },
      healing: { healTeam },
    } as unknown as WorldServiceWhatsAppDependencies;
    const message = context();

    const result = await routeFor(dependencies, "curar").handler.handle(message);

    expect(healTeam).toHaveBeenCalledTimes(1);
    expect(healTeam).toHaveBeenCalledWith({
      playerId,
      sessionId: session.sessionId,
      sourceInboxMessageId: message.inboxMessageId,
      correlationId: message.correlationId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.resultRefId).toBe(session.sessionId);
    expect(result.value.outgoing).toHaveLength(1);
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗥𝗘𝗖𝗨𝗣𝗘𝗥𝗔ÇÃ𝗢 𝗖𝗢𝗡𝗖𝗟𝗨Í𝗗𝗔");
    expect(result.value.outgoing[0]?.payload.text).toContain("HP restaurado");
    expect(result.value.outgoing[0]?.payload.text).toContain("PP restaurado");
  });

  it("never renders recovery success when the mechanical service rejects healing", async () => {
    const playerId = createPlayerId();
    const session = activeCenterSession(playerId);
    const dependencies = {
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE" as const, created: false }),
      },
      world: {
        getLocation: async () => {
          throw new Error("not expected");
        },
      },
      sessions: {
        openVisit: async () => {
          throw new Error("not expected");
        },
        loadActiveSession: async () => ok(session),
        closeVisit: async () => {
          throw new Error("not expected");
        },
      },
      healing: {
        healTeam: async () => err(appError("ACTION_INVALID", "Active battle blocks healing")),
      },
    } as unknown as WorldServiceWhatsAppDependencies;

    const result = await routeFor(dependencies, "curar").handler.handle(context());

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "ACTION_INVALID" }),
    });
  });
});

describe("Pokemon PC deposit early block", () => {
  function makeTeamSnapshot(playerId: ReturnType<typeof createPlayerId>, size: number) {
    return {
      playerId,
      team: Array.from({ length: size }, (_, index) => ({
        pokemonInstanceId: createPokemonInstanceId(),
        displayName: index === 0 ? "Ivysaur" : "Pikachu",
        level: 16,
        placementKind: "TEAM" as const,
        boxNo: null,
        slotNo: index + 1,
      })),
      boxes: [],
    };
  }

  it.each([0, 1])("blocks a deposit menu with %i active Pokemon and no reply prompt", async (size) => {
    const playerId = createPlayerId();
    const session = activeCenterSession(playerId);
    const dependencies = {
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE" as const, created: false }),
      },
      sessions: { loadActiveSession: async () => ok(session) },
      pcStorage: { getStorage: async () => ok(makeTeamSnapshot(playerId, size)) },
    } as unknown as WorldServiceWhatsAppDependencies;

    const result = await routeFor(dependencies, "depositar").handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.outgoing).toHaveLength(1);
    const payload = result.value.outgoing[0]?.payload;
    expect(payload?.text).toContain("𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢 𝗕𝗟𝗢𝗤𝗨𝗘𝗔𝗗𝗢");
    expect(payload?.text).not.toContain("Responda com o número");
    expect(payload).not.toHaveProperty("worldServicePrompt");
  });

  it("still offers the quoted choice flow when the team has two Pokemon", async () => {
    const playerId = createPlayerId();
    const session = activeCenterSession(playerId);
    const dependencies = {
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE" as const, created: false }),
      },
      sessions: { loadActiveSession: async () => ok(session) },
      pcStorage: { getStorage: async () => ok(makeTeamSnapshot(playerId, 2)) },
    } as unknown as WorldServiceWhatsAppDependencies;

    const result = await routeFor(dependencies, "depositar").handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const payload = result.value.outgoing[0]?.payload;
    expect(payload?.text).toContain("𝗗𝗘𝗣𝗢𝗦𝗜𝗧𝗔𝗥 𝗣𝗢𝗞É𝗠𝗢𝗡");
    expect(payload?.text).toContain("Responda com o número");
    expect(payload).toHaveProperty("worldServicePrompt");
  });
  it("blocks PC withdrawal when all six team slots are occupied", async () => {
    const playerId = createPlayerId();
    const session = activeCenterSession(playerId);
    const storedPokemon = {
      pokemonInstanceId: createPokemonInstanceId(),
      displayName: "Geodude",
      level: 10,
      placementKind: "BOX" as const,
      boxNo: 1,
      slotNo: 6,
    };
    const snapshot = {
      ...makeTeamSnapshot(playerId, 6),
      boxes: [{ boxNo: 1, occupied: 1, capacity: 30 as const, pokemon: [storedPokemon] }],
    };
    const dependencies = {
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE" as const, created: false }),
      },
      sessions: { loadActiveSession: async () => ok(session) },
      pcStorage: { getStorage: async () => ok(snapshot) },
    } as unknown as WorldServiceWhatsAppDependencies;

    const result = await routeFor(dependencies, "retirar").handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const payload = result.value.outgoing[0]?.payload;
    expect(payload?.text).toContain("𝗘𝗤𝗨𝗜𝗣𝗘 𝗖𝗛𝗘𝗜𝗔");
    expect(payload?.text).not.toContain("Responda com o número");
    expect(payload).not.toHaveProperty("worldServicePrompt");
  });

});

describe("Published Poké Mart only", () => {
  function martDependencies(offers: readonly { offerKey: string; itemQuantity: bigint; priceAmount: bigint }[]) {
    const playerId = createPlayerId();
    const session = { ...activeCenterSession(playerId), serviceKind: "POKEMART" as const };
    const dependencies = {
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE" as const, created: false }),
      },
      sessions: { loadActiveSession: async () => ok(session) },
      martAvailability: { listPublishedOffers: async () => offers },
    } as unknown as WorldServiceWhatsAppDependencies;
    return dependencies;
  }

  it("does not expose purchase choices or a prompt when ACTIVE has no offers", async () => {
    const result = await routeFor(martDependencies([]), "comprar").handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error.message);
    expect(result.value.outgoing[0]?.payload.text).toContain("Nenhuma mercadoria disponível");
    expect(result.value.outgoing[0]?.payload).not.toHaveProperty("worldServicePrompt");
  });

  it("shows only actual active offers, not the full static Mart catalog", async () => {
    const result = await routeFor(martDependencies([
      { offerKey: "shop.poke-ball", itemQuantity: 1n, priceAmount: 200n },
    ]), "comprar").handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error.message);
    expect(result.value.outgoing[0]?.payload.text).toContain("Poké Ball");
    expect(result.value.outgoing[0]?.payload.text).not.toContain("Potion");
    expect(result.value.outgoing[0]?.payload).toHaveProperty("worldServicePrompt");
  });
});
