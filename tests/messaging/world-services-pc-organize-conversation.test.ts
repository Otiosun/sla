import { describe, expect, it, vi } from "vitest";
import type {
  IncomingMessage,
  MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { WorldServiceConversationResolver } from "../../src/modules/world-services/conversation-resolver.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import type { PokemonPcStorageSnapshot } from "../../src/modules/world-services/pc-storage-service.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const STORED_POKEMON_ID = createPokemonInstanceId();
const AREA_ID = "00000000-0000-4000-8000-000000003101";
const SESSION_ID = "00000000-0000-4000-8000-000000003102";
const CHAT_REF = "120363000000003101@g.us";
const LIST_PROMPT_ID = "WA-PC-ORGANIZE-LIST";
const LIST_PROMPT_KEY = "inbox:x:world-service:center:pc:organize:list";
const DESTINATION_PROMPT_ID = "WA-PC-ORGANIZE-DESTINATION";
const DESTINATION_PROMPT_KEY = `inbox:x:world-service:center:pc:organize:destination:${STORED_POKEMON_ID}`;
const CONFIRM_PROMPT_ID = "WA-PC-ORGANIZE-CONFIRM";
const CONFIRM_PROMPT_KEY = `inbox:x:world-service:center:pc:organize:confirm:${STORED_POKEMON_ID}:2:5`;

const STORAGE: PokemonPcStorageSnapshot = {
  playerId: PLAYER_ID,
  team: [],
  boxes: [
    {
      boxNo: 1,
      occupied: 1,
      capacity: 30,
      pokemon: [
        {
          pokemonInstanceId: STORED_POKEMON_ID,
          displayName: "Pidgey",
          level: 6,
          placementKind: "BOX",
          boxNo: 1,
          slotNo: 4,
        },
      ],
    },
  ],
};

function centerSession(
  expectedReplyOutboxIdempotencyKey: string | null,
  expectedReplyExternalMessageId: string | null,
): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: "POKEMON_CENTER",
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000003103",
    expectedReplyOutboxIdempotencyKey,
    expectedReplyExternalMessageId,
    revision: 11n,
    createdAt: new Date("2026-09-07T15:00:00.000Z"),
    updatedAt: new Date("2026-09-07T15:05:00.000Z"),
    closedAt: null,
  };
}

function incoming(text: string, replyToExternalMessageId: string | null): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: `pc-organize-${text}-${replyToExternalMessageId ?? "none"}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: CHAT_REF,
    occurredAt: "2026-09-07T15:10:00.000Z",
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
    inboxMessageId: `00000000-0000-4000-8000-0000000032${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000033${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000032${suffix}`,
    idempotencyKey: `inbox:baileys:pc-organize-${suffix}`,
    message: incoming(text, replyToExternalMessageId),
  };
}

function playerResolver() {
  return {
    resolvePlayer: vi.fn(async () =>
      ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
    ),
  };
}

function routeFixture() {
  const getStorage = vi.fn(async () => ok(STORAGE));
  const pcStorage = { getStorage };
  const routes = createWorldServiceWhatsAppRoutes({
    players: playerResolver(),
    world: { getLocation: vi.fn() },
    sessions: {
      openVisit: vi.fn(),
      loadActiveSession: vi.fn(async () => ok(centerSession(null, null))),
      closeVisit: vi.fn(),
    },
    pcStorage,
  });
  return { routes, getStorage };
}

function routeByCommand(
  definitions: ReturnType<typeof createWorldServiceWhatsAppRoutes>,
  command: string,
) {
  const route = definitions.find((definition) => definition.command === command);
  if (route === undefined) throw new Error(`Missing route ${command}`);
  return route;
}

function resolverFixture(promptKey: string, promptId: string) {
  const getStorage = vi.fn(async () => ok(STORAGE));
  const organize = vi.fn(async () =>
    ok({
      kind: "APPLIED" as const,
      pokemonInstanceId: STORED_POKEMON_ID,
      fromBoxNo: 1,
      fromSlotNo: 4,
      toBoxNo: 2,
      toSlotNo: 5,
    }),
  );
  const pcStorage = { getStorage, organize };
  const resolver = new WorldServiceConversationResolver({
    community: {
      resolveChat: async () => ({
        known: true as const,
        groupId: "00000000-0000-4000-8000-000000003104",
        role: "GAME" as const,
        capabilities: ["world" as const],
      }),
    },
    players: playerResolver(),
    world: { getLocation: vi.fn() },
    sessions: {
      loadActiveSession: async () => ok(centerSession(promptKey, promptId)),
      recordSceneProof: vi.fn(),
    },
    replyIntent: {
      isExpectedReply: vi.fn(
        async (input: { replyToExternalMessageId: string }) =>
          input.replyToExternalMessageId === promptId,
      ),
    },
    pcStorage,
  });
  return { resolver, getStorage, organize };
}

describe("Pokemon PC organize conversation", () => {
  it("opens /organizar from the real box snapshot as an exact-reply prompt", async () => {
    const current = routeFixture();

    const result = await routeByCommand(current.routes, "organizar").handler.handle(
      context("/organizar", null, "01"),
    );

    expect(current.getStorage).toHaveBeenCalledWith(PLAYER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗥 𝗖𝗔𝗜𝗫𝗔𝗦");
    expect(result.value.outgoing[0]?.payload.text).toContain("Pidgey");
    expect(result.value.outgoing[0]?.payload.text).toContain("Caixa 01 · Vaga 04");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":center:pc:organize:list");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "11",
    });
  });

  it("turns an exact list reply into a destination prompt without moving anything", async () => {
    const current = resolverFixture(LIST_PROMPT_KEY, LIST_PROMPT_ID);

    const result = await current.resolver.resolve(context("01", LIST_PROMPT_ID, "02"));

    expect(current.getStorage).toHaveBeenCalledWith(PLAYER_ID);
    expect(current.organize).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗡𝗢𝗩𝗢 𝗗𝗘𝗦𝗧𝗜𝗡𝗢");
    expect(result.value.outgoing[0]?.payload.text).toContain("Pidgey");
    expect(result.value.outgoing[0]?.payload.text).toContain("2 / 5");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(
      `:center:pc:organize:destination:${STORED_POKEMON_ID}`,
    );
  });

  it("turns an exact destination reply into confirmation without moving anything", async () => {
    const current = resolverFixture(DESTINATION_PROMPT_KEY, DESTINATION_PROMPT_ID);

    const result = await current.resolver.resolve(context("2 / 5", DESTINATION_PROMPT_ID, "03"));

    expect(current.organize).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔ÇÃ𝗢");
    expect(result.value.outgoing[0]?.payload.text).toContain("Caixa 02 · Vaga 05");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(
      `:center:pc:organize:confirm:${STORED_POKEMON_ID}:2:5`,
    );
  });

  it("organizes only after an exact confirmation and renders the committed movement", async () => {
    const current = resolverFixture(CONFIRM_PROMPT_KEY, CONFIRM_PROMPT_ID);

    const result = await current.resolver.resolve(context("01", CONFIRM_PROMPT_ID, "04"));

    expect(current.organize).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      pokemonInstanceId: STORED_POKEMON_ID,
      boxNo: 2,
      slotNo: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗖𝗔𝗜𝗫𝗔 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗗𝗔");
    expect(result.value.outgoing[0]?.payload.text).toContain("Caixa 01 · Vaga 04");
    expect(result.value.outgoing[0]?.payload.text).toContain("Caixa 02 · Vaga 05");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":center:pc:organize:result");
  });

  it("cancels an exact organize confirmation without mutating storage", async () => {
    const current = resolverFixture(CONFIRM_PROMPT_KEY, CONFIRM_PROMPT_ID);

    const result = await current.resolver.resolve(context("02", CONFIRM_PROMPT_ID, "05"));

    expect(current.organize).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔ÇÃ𝗢 𝗖𝗔𝗡𝗖𝗘𝗟𝗔𝗗𝗔");
  });
});
