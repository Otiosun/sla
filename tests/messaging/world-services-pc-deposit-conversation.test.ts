import { describe, expect, it, vi } from "vitest";
import type {
  IncomingMessage,
  MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { WorldServiceConversationResolver } from "../../src/modules/world-services/conversation-resolver.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import type { PokemonPcStorageSnapshot } from "../../src/modules/world-services/pc-storage-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const TEAM_POKEMON_ID = createPokemonInstanceId();
const SECOND_TEAM_POKEMON_ID = createPokemonInstanceId();
const BOX_POKEMON_ID = createPokemonInstanceId();
const AREA_ID = "00000000-0000-4000-8000-000000002401";
const SESSION_ID = "00000000-0000-4000-8000-000000002402";
const CHAT_REF = "120363000000002401@g.us";
const PROMPT_ID = "WA-PC-DEPOSIT-LIST";
const PROMPT_KEY = "inbox:x:world-service:center:pc:deposit:list";

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
    {
      pokemonInstanceId: SECOND_TEAM_POKEMON_ID,
      displayName: "Charmander",
      level: 7,
      placementKind: "TEAM",
      boxNo: null,
      slotNo: 2,
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
          slotNo: 1,
        },
      ],
    },
  ],
};

function incoming(text: string, replyToExternalMessageId: string | null): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: `pc-deposit-${text}-${replyToExternalMessageId ?? "none"}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: CHAT_REF,
    occurredAt: "2026-09-07T13:00:00.000Z",
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
    inboxMessageId: `00000000-0000-4000-8000-0000000025${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000026${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000025${suffix}`,
    idempotencyKey: `inbox:baileys:pc-deposit-${suffix}`,
    message: incoming(text, replyToExternalMessageId),
  };
}

function session(): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: "POKEMON_CENTER",
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000002403",
    expectedReplyOutboxIdempotencyKey: PROMPT_KEY,
    expectedReplyExternalMessageId: PROMPT_ID,
    revision: 8n,
    createdAt: new Date("2026-09-07T12:50:00.000Z"),
    updatedAt: new Date("2026-09-07T12:55:00.000Z"),
    closedAt: null,
  };
}

function fixture() {
  const getStorage = vi.fn(async () => ok(STORAGE));
  const deposit = vi.fn();
  const replyIntent = {
    isExpectedReply: vi.fn(
      async (input: { replyToExternalMessageId: string }) =>
        input.replyToExternalMessageId === PROMPT_ID,
    ),
  };
  const dependencies = {
    community: {
      resolveChat: async () => ({
        known: true as const,
        groupId: "00000000-0000-4000-8000-000000002404",
        role: "GAME" as const,
        capabilities: ["world" as const],
      }),
    },
    players: {
      resolvePlayer: async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
    },
    world: {
      getLocation: vi.fn(),
    },
    sessions: {
      loadActiveSession: async () => ok(session()),
      recordSceneProof: vi.fn(),
    },
    replyIntent,
    pcStorage: { getStorage, deposit },
  };

  return {
    resolver: new WorldServiceConversationResolver(dependencies),
    getStorage,
    deposit,
    replyIntent,
  };
}

describe("Pokemon PC deposit conversation", () => {
  it("turns exact team-slot reply into a confirmation prompt without mutating storage", async () => {
    const current = fixture();

    const result = await current.resolver.resolve(context("01", PROMPT_ID, "01"));

    expect(current.getStorage).toHaveBeenCalledWith(PLAYER_ID);
    expect(current.deposit).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢");
    expect(result.value.outgoing[0]?.payload.text).toContain("Bulbasaur");
    expect(result.value.outgoing[0]?.payload.text).toContain("Caixa 01");
    expect(result.value.outgoing[0]?.payload.text).toContain("Vaga 02");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(
      `:center:pc:deposit:confirm:${TEAM_POKEMON_ID}`,
    );
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "8",
    });
  });

  it("ignores a stale quoted reply and never reaches PC storage", async () => {
    const current = fixture();
    const stale = incoming("01", "WA-PC-DEPOSIT-OLD");

    await expect(current.resolver.admits(stale)).resolves.toBe(false);
    const result = await current.resolver.resolve(context("01", "WA-PC-DEPOSIT-OLD", "02"));

    expect(current.getStorage).not.toHaveBeenCalled();
    expect(current.deposit).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });
});
