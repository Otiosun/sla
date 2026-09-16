import { describe, expect, it, vi } from "vitest";
import { createPvpWhatsAppRoutes } from "../../src/modules/pvp/whatsapp-handlers.js";
import { ok } from "../../src/shared-kernel/result.js";

describe("PVP WhatsApp routes", () => {
  it("exposes the challenge and acceptance commands", () => {
    const routes = createPvpWhatsAppRoutes({} as never);
    expect(routes.map((route) => route.command)).toEqual(
      expect.arrayContaining(["desafiar", "aceitar"]),
    );
  });

  it("creates a SAME_AREA invitation from one real mention without exposing its id", async () => {
    const createChallenge = vi.fn(async () =>
      ok({ challenge: { id: "11111111-1111-4111-8111-111111111111" }, replayed: false }),
    );
    const routes = createPvpWhatsAppRoutes({
      players: {
        resolvePlayer: vi.fn(async ({ externalId }) =>
          ok({
            playerId:
              externalId === "target"
                ? "22222222-2222-4222-8222-222222222222"
                : "33333333-3333-4333-8333-333333333333",
          }),
        ),
      },
      pvp: { createChallenge, acceptChallenge: vi.fn(), startEncounter: vi.fn() },
      openChallengeIdForTarget: vi.fn(),
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
        senderRef: "sender",
        chatRef: "chat",
        occurredAt: "2026-09-11T00:00:00.000Z",
        text: "/desafiar @target",
        mentions: ["target"],
        mediaRefs: [],
        replyToExternalMessageId: null,
      },
    });
    expect(createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ formatKey: "1V1", reachPolicy: "SAME_AREA" }),
    );
    expect(result.ok && JSON.stringify(result.value.outgoing)).not.toContain("11111111");
  });

  it("accepts the target's open invitation and starts the Battle without a READY step", async () => {
    const acceptChallenge = vi.fn(async () => ok({ challenge: {} }));
    const startEncounter = vi.fn(async () =>
      ok({
        challengeId: "11111111-1111-4111-8111-111111111111",
        encounterId: "22222222-2222-4222-8222-222222222222",
        battleId: "33333333-3333-4333-8333-333333333333",
        turnWindowId: "44444444-4444-4444-8444-444444444444",
        replayed: false,
      }),
    );
    const routes = createPvpWhatsAppRoutes({
      players: {
        resolvePlayer: vi.fn(async () => ok({ playerId: "55555555-5555-4555-8555-555555555555" })),
      },
      pvp: { createChallenge: vi.fn(), acceptChallenge, startEncounter },
      openChallengeIdForTarget: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
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
        senderRef: "target",
        chatRef: "chat",
        occurredAt: "2026-09-11T00:00:00.000Z",
        text: "/aceitar",
        mediaRefs: [],
        replyToExternalMessageId: null,
      },
    });

    expect(acceptChallenge).toHaveBeenCalledWith({
      challengeId: "11111111-1111-4111-8111-111111111111",
      actorPlayerId: "55555555-5555-4555-8555-555555555555",
    });
    expect(startEncounter).toHaveBeenCalledWith({
      challengeId: "11111111-1111-4111-8111-111111111111",
      actorPlayerId: "55555555-5555-4555-8555-555555555555",
    });
    expect(result.ok && JSON.stringify(result.value.outgoing)).not.toContain("33333333");
  });
});
