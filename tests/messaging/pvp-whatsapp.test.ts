import { describe, expect, it, vi } from "vitest";
import { createPvpWhatsAppRoutes } from "../../src/modules/pvp/whatsapp-handlers.js";
import { ok } from "../../src/shared-kernel/result.js";

describe("PVP WhatsApp routes", () => {
  it("exposes the challenge and acceptance commands", () => {
    const routes = createPvpWhatsAppRoutes({} as never);
    expect(routes.map((route) => route.command)).toEqual(
      expect.arrayContaining(["desafiar", "aceitar", "recusar", "cancelar"]),
    );
  });

  it("creates a SAME_AREA invitation, mentions both sides, and never exposes its internal id", async () => {
    const createChallenge = vi.fn(async () =>
      ok({ challenge: { id: "11111111-1111-4111-8111-111111111111" }, replayed: false }),
    );
    const routes = createPvpWhatsAppRoutes({
      players: {
        resolvePlayer: vi.fn(async ({ externalId }) =>
          ok({
            playerId:
              externalId === "target@s.whatsapp.net"
                ? "22222222-2222-4222-8222-222222222222"
                : "33333333-3333-4333-8333-333333333333",
          }),
        ),
      },
      pvp: {
        createChallenge,
        acceptChallenge: vi.fn(),
        startEncounter: vi.fn(),
        declineChallenge: vi.fn(),
        cancelChallenge: vi.fn(),
      },
      openChallengeIdForTarget: vi.fn(),
      openChallengeIdForChallenger: vi.fn(),
    } as never);
    const route = routes.find((entry) => entry.command === "desafiar");
    if (route === undefined) throw new Error("missing route");
    const result = await route.handler.handle({
      inboxMessageId: "inbox",
      correlationId: "correlation",
      causationId: "cause",
      idempotencyKey: "message",
      message: {
        provider: "baileys",
        externalMessageId: "external",
        senderRef: "sender@s.whatsapp.net",
        chatRef: "chat",
        occurredAt: "2026-09-11T00:00:00.000Z",
        text: "/desafiar @target",
        mentions: ["target@s.whatsapp.net"],
        mediaRefs: [],
        replyToExternalMessageId: null,
      },
    });
    expect(createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ formatKey: "1V1", reachPolicy: "SAME_AREA" }),
    );
    if (!result.ok) throw result.error;
    const outgoing = result.value.outgoing[0];
    expect(outgoing?.payload.text).toBe(
      "⚔️ *@sender desafiou @target.*\n\n@target, `/aceitar` para começar ou `/recusar`.\nO desafiante pode usar `/cancelar` antes da resposta.",
    );
    expect(outgoing?.payload.mentions).toEqual(["sender@s.whatsapp.net", "target@s.whatsapp.net"]);
    expect(JSON.stringify(result.value.outgoing)).not.toContain("11111111");
  });

  it("accepts the target's invitation and starts Battle immediately with both mentions", async () => {
    const challengerPlayerId = "66666666-6666-4666-8666-666666666666";
    const targetPlayerId = "55555555-5555-4555-8555-555555555555";
    const acceptChallenge = vi.fn(async () =>
      ok({
        challenge: {
          challengerPlayerId,
          targetPlayerId,
        },
      }),
    );
    const startEncounter = vi.fn(async () =>
      ok({
        challengeId: "11111111-1111-4111-8111-111111111111",
        encounterId: "22222222-2222-4222-8222-222222222222",
        battleId: "33333333-3333-4333-8333-333333333333",
        turnWindowId: "44444444-4444-4444-8444-444444444444",
        replayed: false,
      }),
    );
    const externalRefForPlayer = vi.fn(async (id: string) =>
      id === challengerPlayerId ? "111@s.whatsapp.net" : "222@s.whatsapp.net",
    );
    const routes = createPvpWhatsAppRoutes({
      players: {
        resolvePlayer: vi.fn(async () => ok({ playerId: targetPlayerId })),
      },
      pvp: {
        createChallenge: vi.fn(),
        acceptChallenge,
        startEncounter,
        declineChallenge: vi.fn(),
        cancelChallenge: vi.fn(),
      },
      openChallengeIdForTarget: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
      openChallengeIdForChallenger: vi.fn(),
      externalRefForPlayer,
    } as never);
    const route = routes.find((entry) => entry.command === "aceitar");
    if (route === undefined) throw new Error("missing route");

    const result = await route.handler.handle({
      inboxMessageId: "inbox",
      correlationId: "correlation",
      causationId: "cause",
      idempotencyKey: "message",
      message: {
        provider: "baileys",
        externalMessageId: "external",
        senderRef: "222@s.whatsapp.net",
        chatRef: "chat",
        occurredAt: "2026-09-11T00:00:00.000Z",
        text: "/aceitar",
        mediaRefs: [],
        replyToExternalMessageId: null,
      },
    });

    expect(acceptChallenge).toHaveBeenCalledWith({
      challengeId: "11111111-1111-4111-8111-111111111111",
      actorPlayerId: targetPlayerId,
    });
    expect(startEncounter).toHaveBeenCalledWith({
      challengeId: "11111111-1111-4111-8111-111111111111",
      actorPlayerId: targetPlayerId,
    });
    if (!result.ok) throw result.error;
    const outgoing = result.value.outgoing[0];
    expect(outgoing?.payload.text).toBe("⚔️ *@111 × @222*\n\nBatalha iniciada.");
    expect(outgoing?.payload.mentions).toEqual(["111@s.whatsapp.net", "222@s.whatsapp.net"]);
    expect(JSON.stringify(result.value.outgoing)).not.toContain("33333333");
  });
});
