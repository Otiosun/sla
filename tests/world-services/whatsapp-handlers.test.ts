import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import type { WorldServiceWhatsAppDependencies } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
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

function activeCenterSession(playerId: ReturnType<typeof createPlayerId>): WorldServiceSessionRecord {
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

function routeFor(
  dependencies: WorldServiceWhatsAppDependencies,
  command: string,
) {
  const route = createWorldServiceWhatsAppRoutes(dependencies).find(
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
