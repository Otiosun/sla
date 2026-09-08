import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000004001";
const SESSION_ID = "00000000-0000-4000-8000-000000004002";

function context(): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000004003",
    correlationId: "00000000-0000-4000-8000-000000004004",
    causationId: "00000000-0000-4000-8000-000000004003",
    idempotencyKey: "inbox:baileys:pokemart-media",
    message: {
      provider: "baileys",
      externalMessageId: "pokemart-media",
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000004001@g.us",
      occurredAt: "2026-09-08T14:50:00.000Z",
      text: "/pokemart",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

describe("Poké Mart visual entry", () => {
  it("sends facade first and merchant second, binding the active prompt only to the merchant image", async () => {
    const media = {
      pokemartEntry: vi.fn(() => ({
        facadeImageUrl: "https://assets.example.com/pokemart-facade.png",
        merchantImageUrl: "https://assets.example.com/pokemart-merchant.png",
      })),
    };
    const dependencies = {
      players: {
        resolvePlayer: vi.fn(async () =>
          ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
        ),
      },
      world: {
        getLocation: vi.fn(async () =>
          ok({
            playerId: PLAYER_ID,
            contentReleaseId: "00000000-0000-4000-8000-000000004005",
            areaId: AREA_ID,
            areaSlug: "vila-dos-arrozais",
            areaDisplayName: "Vila dos Arrozais",
            regionId: "00000000-0000-4000-8000-000000004006",
            regionSlug: "zhoulia",
            regionDisplayName: "Zhoulia",
            safePoint: true,
            revision: 0n,
            enteredAt: new Date("2026-09-08T14:00:00.000Z"),
            requiresRelocation: false,
            relocationAreaId: null,
            connections: [],
          }),
        ),
      },
      sessions: {
        openVisit: vi.fn(async () =>
          ok({
            sessionId: SESSION_ID,
            playerId: PLAYER_ID,
            areaId: AREA_ID,
            serviceKind: "POKEMART" as const,
            state: "OPEN" as const,
            sceneProofId: "00000000-0000-4000-8000-000000004007",
            expectedReplyOutboxIdempotencyKey: null,
            expectedReplyExternalMessageId: null,
            revision: 4n,
            createdAt: new Date("2026-09-08T14:49:00.000Z"),
            updatedAt: new Date("2026-09-08T14:49:00.000Z"),
            closedAt: null,
          }),
        ),
        loadActiveSession: vi.fn(),
        closeVisit: vi.fn(),
      },
      media,
    };

    const routes = createWorldServiceWhatsAppRoutes(
      dependencies as Parameters<typeof createWorldServiceWhatsAppRoutes>[0],
    );
    const route = routes.find((definition) => definition.command === "pokemart");
    if (route === undefined) throw new Error("Missing pokemart route");

    const result = await route.handler.handle(context());

    expect(media.pokemartEntry).toHaveBeenCalledWith(AREA_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing).toHaveLength(2);
    expect(result.value.outgoing[0]).toMatchObject({
      messageType: "IMAGE",
      payload: {
        imageUrl: "https://assets.example.com/pokemart-facade.png",
      },
    });
    expect(result.value.outgoing[0]?.payload.caption).toContain("𝗩𝗜𝗟𝗔 𝗗𝗢𝗦 𝗔𝗥𝗥𝗢𝗭𝗔𝗜𝗦");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toBeUndefined();
    expect(result.value.outgoing[1]).toMatchObject({
      messageType: "IMAGE",
      payload: {
        imageUrl: "https://assets.example.com/pokemart-merchant.png",
        worldServicePrompt: { playerId: PLAYER_ID, expectedRevision: "4" },
      },
    });
    expect(result.value.outgoing[1]?.payload.caption).toContain("𝗖𝗢𝗠𝗘𝗥𝗖𝗜𝗔𝗡𝗧𝗘");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":entry:facade");
    expect(result.value.outgoing[1]?.idempotencyKey).toContain(":entry:merchant");
  });
});
