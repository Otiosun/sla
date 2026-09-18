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
const TEAM_POKEMON_ID = createPokemonInstanceId();
const BOX_POKEMON_ID = createPokemonInstanceId();
const AREA_ID = "00000000-0000-4000-8000-000000002701";
const SESSION_ID = "00000000-0000-4000-8000-000000002702";
const CHAT_REF = "120363000000002701@g.us";
const PROMPT_ID = "WA-PC-WITHDRAW-LIST";
const PROMPT_KEY = "inbox:x:world-service:center:pc:withdraw:list";
const CONFIRM_PROMPT_ID = "WA-PC-WITHDRAW-CONFIRM";
const CONFIRM_PROMPT_KEY = `inbox:x:world-service:center:pc:withdraw:confirm:${BOX_POKEMON_ID}`;

const STORAGE: PokemonPcStorageSnapshot = {
  playerId: PLAYER_ID,
  team: [
    {
      pokemonInstanceId: TEAM_POKEMON_ID,
      displayName: "Bulbasaur",
      level: 8,
      placementKind: "TEAM",
      boxNo: null,
      slotNo: 1,
    },
  ],
  boxes: [
    {
      boxNo: 1,
      occupied: 1,
      capacity: 30,
      pokemon: [
        {
          pokemonInstanceId: BOX_POKEMON_ID,
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
    sceneProofId: "00000000-0000-4000-8000-000000002703",
    expectedReplyOutboxIdempotencyKey,
    expectedReplyExternalMessageId,
    revision: 9n,
    createdAt: new Date("2026-09-07T14:00:00.000Z"),
    updatedAt: new Date("2026-09-07T14:05:00.000Z"),
    closedAt: null,
  };
}

function incoming(text: string, replyToExternalMessageId: string | null): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: `pc-withdraw-${text}-${replyToExternalMessageId ?? "none"}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: CHAT_REF,
    occurredAt: "2026-09-07T14:10:00.000Z",
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
    inboxMessageId: `00000000-0000-4000-8000-0000000028${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000029${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000028${suffix}`,
    idempotencyKey: `inbox:baileys:pc-withdraw-${suffix}`,
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
  const routes = createWorldServiceWhatsAppRoutes({
    players: playerResolver(),
    world: { getLocation: vi.fn() },
    sessions: {
      openVisit: vi.fn(),
      loadActiveSession: vi.fn(async () => ok(centerSession(null, null))),
      closeVisit: vi.fn(),
    },
    pcStorage: { getStorage },
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
  const withdraw = vi.fn(async () =>
    ok({
      kind: "APPLIED" as const,
      pokemonInstanceId: BOX_POKEMON_ID,
      fromBoxNo: 1,
      fromSlotNo: 4,
      teamSlotNo: 2,
    }),
  );
  const resolver = new WorldServiceConversationResolver({
    community: {
      resolveChat: async () => ({
        known: true as const,
        groupId: "00000000-0000-4000-8000-000000002704",
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
    pcStorage: { getStorage, withdraw },
  });
  return { resolver, getStorage, withdraw };
}

describe("Pokemon PC withdraw conversation", () => {
  it("opens /retirar from the real box snapshot as an exact-reply prompt", async () => {
    const current = routeFixture();

    const result = await routeByCommand(current.routes, "retirar").handler.handle(
      context("/retirar", null, "01"),
    );

    expect(current.getStorage).toHaveBeenCalledWith(PLAYER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗥𝗘𝗧𝗜𝗥𝗔𝗥 𝗣𝗢𝗞É𝗠𝗢𝗡");
    expect(result.value.outgoing[0]?.payload.text).toContain("Pidgey");
    expect(result.value.outgoing[0]?.payload.text).toContain("Caixa 01 · Vaga 04");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":center:pc:withdraw:list");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "9",
    });
  });

  it("turns an exact list reply into confirmation without mutating storage", async () => {
    const current = resolverFixture(PROMPT_KEY, PROMPT_ID);

    const result = await current.resolver.resolve(context("01", PROMPT_ID, "02"));

    expect(current.getStorage).toHaveBeenCalledWith(PLAYER_ID);
    expect(current.withdraw).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗥𝗘𝗧𝗜𝗥𝗔𝗗𝗔");
    expect(result.value.outgoing[0]?.payload.text).toContain("Pidgey");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(
      `:center:pc:withdraw:confirm:${BOX_POKEMON_ID}`,
    );
  });

  it("withdraws only after an exact confirmation reply and renders the real team slot", async () => {
    const current = resolverFixture(CONFIRM_PROMPT_KEY, CONFIRM_PROMPT_ID);

    const result = await current.resolver.resolve(context("01", CONFIRM_PROMPT_ID, "03"));

    expect(current.withdraw).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      pokemonInstanceId: BOX_POKEMON_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗣𝗢𝗞É𝗠𝗢𝗡 𝗥𝗘𝗧𝗜𝗥𝗔𝗗𝗢");
    expect(result.value.outgoing[0]?.payload.text).toContain("Caixa 01 · Vaga 04");
    expect(result.value.outgoing[0]?.payload.text).toContain("Equipe · Posição 02");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":center:pc:withdraw:result");
  });

  it("cancels an exact withdraw confirmation without mutating storage", async () => {
    const current = resolverFixture(CONFIRM_PROMPT_KEY, CONFIRM_PROMPT_ID);

    const result = await current.resolver.resolve(context("02", CONFIRM_PROMPT_ID, "04"));

    expect(current.withdraw).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗥𝗘𝗧𝗜𝗥𝗔𝗗𝗔 𝗖𝗔𝗡𝗖𝗘𝗟𝗔𝗗𝗔");
  });
});
