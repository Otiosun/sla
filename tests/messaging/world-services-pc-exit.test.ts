import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000003501";
const SESSION_ID = "00000000-0000-4000-8000-000000003502";

function context(suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000036${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000037${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000036${suffix}`,
    idempotencyKey: `inbox:baileys:pc-exit-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `pc-exit-${suffix}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000003501@g.us",
      occurredAt: "2026-09-07T21:30:00.000Z",
      text: "/sair",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function centerSession(promptKey: string | null, revision = 12n): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: "POKEMON_CENTER",
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000003503",
    expectedReplyOutboxIdempotencyKey: promptKey,
    expectedReplyExternalMessageId: promptKey === null ? null : "WA-PC-ACTIVE",
    revision,
    createdAt: new Date("2026-09-07T21:00:00.000Z"),
    updatedAt: new Date("2026-09-07T21:20:00.000Z"),
    closedAt: null,
  };
}

function fixture(active: WorldServiceSessionRecord) {
  const closeVisit = vi.fn(async () =>
    ok({
      ...active,
      state: "CLOSED" as const,
      revision: active.revision + 1n,
      closedAt: new Date("2026-09-07T21:30:00.000Z"),
    }),
  );
  const routes = createWorldServiceWhatsAppRoutes({
    players: {
      resolvePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
      ),
    },
    world: { getLocation: vi.fn() },
    sessions: {
      openVisit: vi.fn(),
      loadActiveSession: vi.fn(async () => ok(active)),
      closeVisit,
    },
  });
  const exit = routes.find((route) => route.command === "sair");
  if (exit === undefined) throw new Error("Missing /sair route");
  return { exit, closeVisit };
}

describe("Pokémon PC nested exit", () => {
  it("returns from the PC to the Pokémon Center without closing the Center visit", async () => {
    const current = fixture(centerSession("inbox:x:world-service:center:pc:organize:result", 12n));

    const result = await current.exit.handler.handle(context("01"));

    expect(current.closeVisit).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resultRefId).toBe(SESSION_ID);
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗖𝗘𝗡𝗧𝗥𝗢 𝗣𝗢𝗞É𝗠𝗢𝗡");
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗘𝗡𝗙𝗘𝗥𝗠𝗘𝗜𝗥𝗔 𝗛𝗔𝗡𝗔");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":center:return");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "12",
    });
  });

  it("still closes the Pokémon Center when /sair is used outside the PC surface", async () => {
    const current = fixture(centerSession("inbox:x:world-service:center:return", 13n));

    const result = await current.exit.handler.handle(context("02"));

    expect(current.closeVisit).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      expectedRevision: 13n,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("Atendimento encerrado");
  });
});
