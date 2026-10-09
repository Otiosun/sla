import { describe, expect, it, vi } from "vitest";
import { createPveSceneRoutes } from "../../src/modules/battle/pve-scene-whatsapp.js";
import { ok } from "../../src/shared-kernel/result.js";

const context = {
  inboxMessageId: "33333333-3333-4333-8333-333333333333",
  correlationId: "44444444-4444-4444-8444-444444444444",
  causationId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "inbox:baileys:test",
  originalMessageText: "/capturar pikachu",
  message: {
    provider: "baileys",
    externalMessageId: "msg-1",
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: "120363000000@g.us",
    occurredAt: "2026-10-08T12:00:00.000Z",
    text: "/capturar pikachu",
    mentions: [],
    mediaRefs: [],
    replyToExternalMessageId: null,
  },
} as never;

describe("contextual /capturar bridge", () => {
  it("falls back to competitive identification only when canonical PVE has no battle or encounter", async () => {
    const competitiveResult = {
      resultRefType: "COMPETITIVE_SPAWN",
      resultRefId: "11111111-1111-4111-8111-111111111111",
      outgoing: [],
    };
    const competitiveCapture = {
      resolveGuessCommand: vi.fn().mockResolvedValue(ok(competitiveResult)),
    };
    const routes = createPveSceneRoutes({
      players: {
        resolvePlayer: vi.fn().mockResolvedValue(
          ok({
            playerId: "22222222-2222-4222-8222-222222222222",
            state: "COMPLETE",
            created: false,
          }),
        ),
      },
      activeBattleId: vi.fn().mockResolvedValue(null),
      admins: { resolvePrincipal: vi.fn().mockResolvedValue(null) },
      competitiveCapture,
    } as never);

    const capture = routes.find((route) => route.command === "capturar");
    expect(capture).toBeDefined();
    expect(capture?.policy?.requiredAnyGroupCapabilities).toContain("world");

    const result = await capture?.handler.handle(context);
    expect(competitiveCapture.resolveGuessCommand).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ok(competitiveResult));
  });

  it("does not steal a canonical encounter response", async () => {
    const competitiveCapture = {
      resolveGuessCommand: vi.fn(),
    };
    const routes = createPveSceneRoutes({
      players: {
        resolvePlayer: vi.fn().mockResolvedValue(
          ok({
            playerId: "22222222-2222-4222-8222-222222222222",
            state: "COMPLETE",
            created: false,
          }),
        ),
      },
      activeBattleId: vi.fn().mockResolvedValue(null),
      admins: { resolvePrincipal: vi.fn().mockResolvedValue(null) },
      encounters: {
        activeForPlayer: vi.fn().mockResolvedValue(
          ok({
            encounterId: "55555555-5555-4555-8555-555555555555",
            battleId: null,
            contentReleaseId: "66666666-6666-4666-8666-666666666666",
            status: "ACTIVE",
            revision: 0,
          }),
        ),
      },
      captureBalls: {
        listAvailable: vi.fn().mockResolvedValue([]),
      },
      competitiveCapture,
    } as never);

    const capture = routes.find((route) => route.command === "capturar");
    const result = await capture?.handler.handle(context);

    expect(competitiveCapture.resolveGuessCommand).not.toHaveBeenCalled();
    expect(result?.ok).toBe(true);
  });
});
