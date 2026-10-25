import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";
const POKEMON_ID = "00000000-0000-4000-8000-000000000025";

function context(command: string): MessageHandlerContext {
  return {
    inboxMessageId: "read-page-inbox",
    correlationId: "00000000-0000-4000-8000-000000000031",
    causationId: "read-page-inbox",
    idempotencyKey: "read-page",
    message: {
      provider: "baileys",
      externalMessageId: "read-page-message",
      senderRef: "reader@s.whatsapp.net",
      chatRef: "reader@g.us",
      occurredAt: "2026-10-25T03:00:00.000Z",
      text: command,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function fixture(options: { empty?: boolean; blankNickname?: boolean } = {}) {
  const count = options.empty ? 0 : 16;
  const resolvePlayer = vi.fn(async () =>
    ok({ playerId: PLAYER_ID, state: "COMPLETE", created: false }),
  );
  const owned = Array.from({ length: count }, (_, index) => ({
    collectionNo: index + 1,
    pokemonInstanceId: POKEMON_ID,
    displayName: `Charmander ${index + 1}`,
    nickname: options.blankNickname ? "  " : null,
    level: 5,
    xp: 0n,
    currentHp: 19,
    placementKind: "BOX" as const,
    boxNo: 1,
    slotNo: index + 1,
  }));
  const listOwnedPokemon = vi.fn(async () => owned);
  const listInventory = vi.fn(async () =>
    Array.from({ length: count }, (_, index) => ({
      itemId: `item-${index + 1}`,
      itemSlug: `item-${index + 1}`,
      displayName: `Potion ${index + 1}`,
      quantity: 3n,
    })),
  );
  const listPokedex = vi.fn(async () =>
    Array.from({ length: count }, (_, index) => ({
      speciesId: `species-${index + 1}`,
      nationalDex: index + 1,
      speciesSlug: `species-${index + 1}`,
      displayName: `Species ${index + 1}`,
      seenCount: 2n,
      caughtCount: 1n,
    })),
  );
  const policyGate = { authorize: vi.fn(async () => ok(undefined)) };
  const routes = createOperationalUxRoutes({
    registration: { resolvePlayer },
    reads: { listOwnedPokemon, listInventory, listPokedex },
  } as never);
  return {
    router: new MessageRouter(routes, policyGate),
    listOwnedPokemon,
    listInventory,
    listPokedex,
    resolvePlayer,
    policyGate,
  };
}

function rendered(result: Awaited<ReturnType<MessageRouter["dispatch"]>>): string {
  expect(result.ok).toBe(true);
  if (!result.ok) return "";
  const text = result.value?.outgoing[0]?.payload.text;
  return typeof text === "string" ? text : "";
}

describe("operational read-only page UX", () => {
  it.each(["/colecao", "/box", "/inventario", "/pokedex"] as const)(
    "offers actual next/previous commands for %s without leaking internal ids",
    async (command) => {
      const f = fixture();
      const first = rendered(await f.router.dispatch(context(command)));
      const second = rendered(await f.router.dispatch(context(`${command} 2`)));
      expect(first).toContain("📄 Página 1/2");
      expect(first).toContain(`➡️ Próxima: \`${command} 2\``);
      expect(first).not.toContain("Anterior:");
      expect(second).toContain("📄 Página 2/2");
      expect(second).toContain(`⬅️ Anterior: \`${command} 1\``);
      expect(second).not.toContain("Próxima:");
      expect(first).not.toContain(POKEMON_ID);
      expect(second).not.toContain(POKEMON_ID);
      expect(f.policyGate.authorize).not.toHaveBeenCalled();
    },
  );

  it.each(["/colecao", "/box", "/inventario", "/pokedex"] as const)(
    "does not pretend page 2 of an empty %s is a valid empty collection",
    async (command) => {
      const f = fixture({ empty: true });
      const first = rendered(await f.router.dispatch(context(command)));
      expect(first).not.toContain("Página 1/1");
      const invalid = await f.router.dispatch(context(`${command} 2`));
      expect(invalid).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    },
  );

  it.each(["/pokedex 1 extra", "/inventario 1e2", "/colecao 0x2", "/box 1.0"] as const)(
    "rejects malformed or ambiguous pagination %s before reading the projection",
    async (command) => {
      const f = fixture();
      const result = await f.router.dispatch(context(command));
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
      if (!result.ok) expect(result.error.message).toContain(command.split(" ")[0]);
      expect(f.listOwnedPokemon).not.toHaveBeenCalled();
      expect(f.listInventory).not.toHaveBeenCalled();
      expect(f.listPokedex).not.toHaveBeenCalled();
    },
  );

  it("uses the species name instead of a blank nickname in the box and collection", async () => {
    const f = fixture({ blankNickname: true });
    const box = rendered(await f.router.dispatch(context("/box")));
    const collection = rendered(await f.router.dispatch(context("/colecao")));
    expect(box).toContain("*Charmander 1*");
    expect(collection).toContain("*Charmander 1*");
    expect(box).not.toContain("**");
    expect(collection).not.toContain("**");
  });

  it("keeps suspended players' read-only projections accessible", async () => {
    const f = fixture();
    for (const command of ["/colecao", "/box", "/inventario", "/pokedex"]) {
      expect((await f.router.dispatch(context(command))).ok).toBe(true);
    }
    expect(f.policyGate.authorize).not.toHaveBeenCalled();
  });
});
