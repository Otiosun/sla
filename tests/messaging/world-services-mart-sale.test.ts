import { describe, expect, it, vi } from "vitest";
import { insufficientInventory } from "../../src/modules/economy/errors.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { WorldServiceConversationResolver } from "../../src/modules/world-services/conversation-resolver.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000002001";
const CHAT_REF = "120363000000002001@g.us";
const SESSION_ID = "00000000-0000-4000-8000-000000002002";
const ITEM_ID = "00000000-0000-4000-8000-000000002003";
const CURRENCY_ID = "00000000-0000-4000-8000-000000002004";

const SELLABLE_POTION = {
  offerKey: "shop.sell.potion",
  itemId: ITEM_ID,
  displayName: "Potion",
  currencyId: CURRENCY_ID,
  unitSaleAmount: 125n,
  inventoryQuantity: 3n,
} as const;

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
    occurredAt: "2026-09-07T08:00:00.000Z",
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
    inboxMessageId: `00000000-0000-4000-8000-0000000021${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000022${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000021${suffix}`,
    idempotencyKey: `inbox:baileys:mart-sale-${suffix}`,
    message: incoming(text, replyToExternalMessageId, `mart-sale-${suffix}`),
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
    sceneProofId: "00000000-0000-4000-8000-000000002005",
    expectedReplyOutboxIdempotencyKey,
    expectedReplyExternalMessageId,
    revision,
    createdAt: new Date("2026-09-07T07:50:00.000Z"),
    updatedAt: new Date("2026-09-07T07:55:00.000Z"),
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
    contentReleaseId: "00000000-0000-4000-8000-000000002006",
    areaId: AREA_ID,
    areaSlug: "vila-dos-arrozais",
    areaDisplayName: "Vila dos Arrozais",
    regionId: "00000000-0000-4000-8000-000000002007",
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    safePoint: true,
    revision: 0n,
    enteredAt: new Date("2026-09-07T07:00:00.000Z"),
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

describe("Poké Mart sale conversation", () => {
  it("opens /vender with only configured sellable inventory from the active Poké Mart visit", async () => {
    const current = session(null, null, 3n);
    const listSellableInventory = vi.fn(async () => ok([SELLABLE_POTION]));
    const dependencies = {
      players: playerResolver(),
      world: { getLocation: vi.fn(async () => ok(worldLocation())) },
      sessions: {
        openVisit: vi.fn(),
        loadActiveSession: vi.fn(async () => ok(current)),
        closeVisit: vi.fn(),
      },
      economy: { listSellableInventory },
    };
    const routes = createWorldServiceWhatsAppRoutes(dependencies);

    const result = await routeByCommand(routes, "vender").handler.handle(
      context("/vender", null, "01"),
    );

    expect(listSellableInventory).toHaveBeenCalledWith(PLAYER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗩𝗘𝗡𝗗𝗘𝗥");
    expect(result.value.outgoing[0]?.payload.text).toContain("`01` Potion");
    expect(result.value.outgoing[0]?.payload.text).toContain("x03");
    expect(result.value.outgoing[0]?.payload.text).toContain("₽125");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":mart:sale:list");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "3",
    });
  });

  it("turns an exact sale-list reply into a configured quantity prompt", async () => {
    const promptId = "WA-MART-SALE-LIST";
    const current = session("inbox:x:world-service:mart:sale:list", promptId, 4n);
    const listSellableInventory = vi.fn(async () => ok([SELLABLE_POTION]));
    const saleEconomy = {
      purchaseQuantity: vi.fn(),
      listSellableInventory,
      sellQuantity: vi.fn(),
    };
    const resolver = new WorldServiceConversationResolver({
      community: {
        resolveChat: async () => ({
          known: true,
          groupId: "00000000-0000-4000-8000-000000002008",
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
      economy: saleEconomy,
    });

    const result = await resolver.resolve(context("01", promptId, "02"));

    expect(listSellableInventory).toHaveBeenCalledWith(PLAYER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("Potion");
    expect(result.value.outgoing[0]?.payload.text).toContain("₽125");
    expect(result.value.outgoing[0]?.payload.text).toContain("Potion / 2");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(
      ":mart:sale:quantity:shop.sell.potion",
    );
  });

  it("executes Potion / 2 as one atomic sale and renders inventory plus wallet result", async () => {
    const promptId = "WA-MART-SALE-QUANTITY";
    const current = session(
      "inbox:x:world-service:mart:sale:quantity:shop.sell.potion",
      promptId,
      5n,
    );
    const sellQuantity = vi.fn(async () =>
      ok({
        playerId: PLAYER_ID,
        contentReleaseId: "00000000-0000-4000-8000-000000002009",
        offerKey: "shop.sell.potion",
        saleQuantity: 2n,
        itemId: ITEM_ID,
        inventoryQuantity: 1n,
        currencyId: CURRENCY_ID,
        saleAmount: 250n,
        walletAmount: 900n,
        replayed: false,
      }),
    );
    const saleEconomy = {
      purchaseQuantity: vi.fn(),
      listSellableInventory: vi.fn(async () => ok([SELLABLE_POTION])),
      sellQuantity,
    };
    const resolver = new WorldServiceConversationResolver({
      community: {
        resolveChat: async () => ({
          known: true,
          groupId: "00000000-0000-4000-8000-000000002008",
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
      economy: saleEconomy,
    });

    const result = await resolver.resolve(context("Potion / 2", promptId, "03"));

    expect(sellQuantity).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      offerKey: "shop.sell.potion",
      quantity: 2n,
      idempotencyKey: "inbox:baileys:mart-sale-03",
      metadata: {
        sourceType: "WORLD_SERVICE_MART",
        sourceId: SESSION_ID,
        reason: "Poké Mart sale",
        actorType: "PLAYER",
        actorId: PLAYER_ID,
        correlationId: "00000000-0000-4000-8000-000000002203",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗩𝗘𝗡𝗗𝗔 𝗖𝗢𝗡𝗖𝗟𝗨Í𝗗𝗔");
    expect(result.value.outgoing[0]?.payload.text).toContain("02x");
    expect(result.value.outgoing[0]?.payload.text).toContain("₽250");
    expect(result.value.outgoing[0]?.payload.text).toContain("₽900");
    expect(result.value.outgoing[0]?.payload.text).toContain("03 → 01");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":mart:sale:result");
  });

  it("renders the client item-not-owned failure instead of leaking the economy error", async () => {
    const promptId = "WA-MART-SALE-QUANTITY-MISSING";
    const current = session(
      "inbox:x:world-service:mart:sale:quantity:shop.sell.potion",
      promptId,
      6n,
    );
    const sellQuantity = vi.fn(async () => err(insufficientInventory(ITEM_ID, 2n)));
    const saleEconomy = {
      purchaseQuantity: vi.fn(),
      listSellableInventory: vi.fn(async () => ok([SELLABLE_POTION])),
      sellQuantity,
    };
    const resolver = new WorldServiceConversationResolver({
      community: {
        resolveChat: async () => ({
          known: true,
          groupId: "00000000-0000-4000-8000-000000002008",
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
      economy: saleEconomy,
    });

    const result = await resolver.resolve(context("Potion / 2", promptId, "04"));

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗜𝗧𝗘𝗠 𝗜𝗡𝗗𝗜𝗦𝗣𝗢𝗡Í𝗩𝗘𝗟");
    expect(result.value.outgoing[0]?.payload.text).toContain("Potion");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":mart:sale:unavailable");
  });
});
