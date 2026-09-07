import { describe, expect, it, vi } from "vitest";
import type {
  IncomingMessage,
  MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { WorldServiceConversationResolver } from "../../src/modules/world-services/conversation-resolver.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000001001";
const CHAT_REF = "120363000000001001@g.us";
const SESSION_ID = "00000000-0000-4000-8000-000000001002";

function incoming(
  text: string,
  replyToExternalMessageId: string | null,
  externalMessageId: string,
): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: CHAT_REF,
    occurredAt: "2026-09-07T07:00:00.000Z",
    text,
    mediaRefs: [],
    replyToExternalMessageId,
  };
}

function context(
  text: string,
  replyToExternalMessageId: string | null,
  suffix: string,
): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000011${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000012${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000011${suffix}`,
    idempotencyKey: `inbox:baileys:mart-${suffix}`,
    message: incoming(text, replyToExternalMessageId, `mart-${suffix}`),
  };
}

function session(
  expectedReplyOutboxIdempotencyKey: string | null,
  expectedReplyExternalMessageId: string | null,
  revision: bigint,
): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: "POKEMART",
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000001003",
    expectedReplyOutboxIdempotencyKey,
    expectedReplyExternalMessageId,
    revision,
    createdAt: new Date("2026-09-07T06:50:00.000Z"),
    updatedAt: new Date("2026-09-07T06:55:00.000Z"),
    closedAt: null,
  };
}

function playerResolver() {
  return {
    resolvePlayer: vi.fn(async () =>
      ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
    ),
  };
}

function worldLocation() {
  return {
    playerId: PLAYER_ID,
    contentReleaseId: "00000000-0000-4000-8000-000000001004",
    areaId: AREA_ID,
    areaSlug: "vila-dos-arrozais",
    areaDisplayName: "Vila dos Arrozais",
    regionId: "00000000-0000-4000-8000-000000001005",
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    safePoint: true,
    revision: 0n,
    enteredAt: new Date("2026-09-07T06:00:00.000Z"),
    requiresRelocation: false,
    relocationAreaId: null,
    connections: [],
  } as const;
}

function exactReplyVerifier(expectedExternalMessageId: string) {
  return {
    isExpectedReply: vi.fn(
      async (input: { replyToExternalMessageId: string }) =>
        input.replyToExternalMessageId === expectedExternalMessageId,
    ),
  };
}

function routeByCommand(
  definitions: ReturnType<typeof createWorldServiceWhatsAppRoutes>,
  command: string,
) {
  const route = definitions.find((definition) => definition.command === command);
  if (route === undefined) throw new Error(`Missing route ${command}`);
  return route;
}

describe("Poké Mart purchase conversation", () => {
  it("opens the approved catalog from /comprar only inside an active Poké Mart visit", async () => {
    const current = session(null, null, 3n);
    const routes = createWorldServiceWhatsAppRoutes({
      players: playerResolver(),
      world: { getLocation: vi.fn(async () => ok(worldLocation())) },
      sessions: {
        openVisit: vi.fn(),
        loadActiveSession: vi.fn(async () => ok(current)),
        closeVisit: vi.fn(),
      },
    });

    const result = await routeByCommand(routes, "comprar").handler.handle(
      context("/comprar", null, "01"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗣𝗥𝗔𝗧𝗘𝗟𝗘𝗜𝗥𝗔𝗦");
    expect(result.value.outgoing[0]?.payload.text).toContain("`03` Potion · *₽300*");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":mart:catalog");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "3",
    });
  });

  it("turns exact catalog reply 03 into a Potion quantity prompt", async () => {
    const promptId = "WA-MART-CATALOG";
    const current = session("inbox:x:world-service:mart:catalog", promptId, 4n);
    const resolver = new WorldServiceConversationResolver({
      community: {
        resolveChat: async () => ({
          known: true,
          groupId: "00000000-0000-4000-8000-000000001006",
          role: "GAME" as const,
          capabilities: ["world" as const],
        }),
      },
      players: playerResolver(),
      world: { getLocation: async () => ok(worldLocation()) },
      sessions: {
        loadActiveSession: async () => ok(current),
        recordSceneProof: vi.fn(),
      },
      replyIntent: exactReplyVerifier(promptId),
      economy: {
        purchaseQuantity: vi.fn(),
      },
    });

    const result = await resolver.resolve(context("03", promptId, "02"));

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗣𝗢𝗧𝗜𝗢𝗡");
    expect(result.value.outgoing[0]?.payload.text).toContain("Potion / 5");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":mart:quantity:shop.potion");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "4",
    });
  });

  it("executes Potion / 5 as one atomic quantity purchase and renders the receipt", async () => {
    const promptId = "WA-MART-QUANTITY";
    const current = session("inbox:x:world-service:mart:quantity:shop.potion", promptId, 5n);
    const purchaseQuantity = vi.fn(async () =>
      ok({
        playerId: PLAYER_ID,
        contentReleaseId: "00000000-0000-4000-8000-000000001007",
        offerKey: "shop.potion",
        purchaseQuantity: 5n,
        itemId: "00000000-0000-4000-8000-000000001008",
        itemQuantity: 5n,
        inventoryQuantity: 8n,
        currencyId: "00000000-0000-4000-8000-000000001009",
        priceAmount: 1500n,
        walletAmount: 950n,
        replayed: false,
      }),
    );
    const resolver = new WorldServiceConversationResolver({
      community: {
        resolveChat: async () => ({
          known: true,
          groupId: "00000000-0000-4000-8000-000000001006",
          role: "GAME" as const,
          capabilities: ["world" as const],
        }),
      },
      players: playerResolver(),
      world: { getLocation: async () => ok(worldLocation()) },
      sessions: {
        loadActiveSession: async () => ok(current),
        recordSceneProof: vi.fn(),
      },
      replyIntent: exactReplyVerifier(promptId),
      economy: { purchaseQuantity },
    });

    const result = await resolver.resolve(context("Potion / 5", promptId, "03"));

    expect(purchaseQuantity).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      offerKey: "shop.potion",
      quantity: 5n,
      idempotencyKey: "inbox:baileys:mart-03",
      metadata: {
        sourceType: "WORLD_SERVICE_MART",
        sourceId: SESSION_ID,
        reason: "Poké Mart purchase",
        actorType: "PLAYER",
        actorId: PLAYER_ID,
        correlationId: "00000000-0000-4000-8000-000000001203",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗖𝗢𝗠𝗣𝗥𝗔 𝗖𝗢𝗡𝗖𝗟𝗨Í𝗗𝗔");
    expect(result.value.outgoing[0]?.payload.text).toContain("*＋ 05x*");
    expect(result.value.outgoing[0]?.payload.text).toContain("*₽1.500*");
    expect(result.value.outgoing[0]?.payload.text).toContain("*₽950*");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":mart:result");
  });
});
