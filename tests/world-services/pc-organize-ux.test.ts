import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { pcOrganizeDestinationPromptSuffix } from "../../src/modules/world-services/pc-organize-conversation.js";
import { resolvePokemonPcOrganizeReply } from "../../src/modules/world-services/pc-organize-resolver.js";
import type { PokemonPcStorageService } from "../../src/modules/world-services/pc-storage-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const pokemonInstanceId = createPokemonInstanceId();
const otherPokemonId = createPokemonInstanceId();
const session = {
  sessionId: randomUUID(),
  playerId,
  revision: 1n,
} as WorldServiceSessionRecord;

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: `test:${randomUUID()}`,
    message: {
      provider: "baileys",
      externalMessageId: randomUUID(),
      senderRef: "5599999999001",
      chatRef: "test@g.us",
      occurredAt: "2026-10-28T12:00:00-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: "quoted-message",
    },
  } as MessageHandlerContext;
}

function fixture() {
  const pokemon = {
    pokemonInstanceId,
    displayName: "Pidgey",
    level: 8,
    placementKind: "BOX" as const,
    boxNo: 1,
    slotNo: 1,
  };
  const otherPokemon = {
    pokemonInstanceId: otherPokemonId,
    displayName: "Geodude",
    level: 9,
    placementKind: "BOX" as const,
    boxNo: 1,
    slotNo: 6,
  };
  const organize = vi.fn();
  const storage = {
    getStorage: async () =>
      ok({
        playerId,
        team: [],
        boxes: [{ boxNo: 1, occupied: 2, capacity: 30 as const, pokemon: [pokemon, otherPokemon] }],
      }),
    organize,
  } as unknown as PokemonPcStorageService;
  async function select(text: string) {
    return resolvePokemonPcOrganizeReply({
      context: context(text),
      session,
      promptKey: pcOrganizeDestinationPromptSuffix(pokemonInstanceId),
      text,
      pcStorage: storage,
    });
  }
  return { select, organize };
}

describe("PC organization destination preview", () => {
  it("rejects occupied destination before any confirmation or write", async () => {
    const { select, organize } = fixture();
    const result = await select("1/6");
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("Occupied-slot response was unavailable");
    const payload = result.value.outgoing[0]?.payload;
    expect(payload?.text).toContain("𝗩𝗔𝗚𝗔 𝗢𝗖𝗨𝗣𝗔𝗗𝗔");
    expect(payload?.text).toContain("Geodude");
    expect(payload?.text).not.toContain("CONFIRMAR");
    expect(payload).not.toHaveProperty("worldServicePrompt");
    expect(organize).not.toHaveBeenCalled();
  });

  it("treats the current position as a no-op", async () => {
    const { select, organize } = fixture();
    const result = await select("1/1");
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("No-op response was unavailable");
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗣𝗢𝗦𝗜ÇÃ𝗢 𝗜𝗡𝗔𝗟𝗧𝗘𝗥𝗔𝗗𝗔");
    expect(organize).not.toHaveBeenCalled();
  });

  it("still offers confirmation when the destination is free", async () => {
    const { select, organize } = fixture();
    const result = await select("2/5");
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("Free-slot response was unavailable");
    const payload = result.value.outgoing[0]?.payload;
    expect(payload?.text).toContain("𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔ÇÃ𝗢");
    expect(payload).toHaveProperty("worldServicePrompt");
    expect(organize).not.toHaveBeenCalled();
  });
});
