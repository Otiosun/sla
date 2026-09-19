import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000002001";
const SESSION_ID = "00000000-0000-4000-8000-000000002002";

function context(): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000002003",
    correlationId: "00000000-0000-4000-8000-000000002004",
    causationId: "00000000-0000-4000-8000-000000002003",
    idempotencyKey: "inbox:baileys:pc-nesting",
    message: {
      provider: "baileys",
      externalMessageId: "pc-nesting-message",
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000002001@g.us",
      occurredAt: "2026-09-07T10:30:00.000Z",
      text: "/pc",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function centerSession(revision = 4n): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: "POKEMON_CENTER",
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000002005",
    expectedReplyOutboxIdempotencyKey: null,
    expectedReplyExternalMessageId: null,
    revision,
    createdAt: new Date("2026-09-07T10:20:00.000Z"),
    updatedAt: new Date("2026-09-07T10:20:00.000Z"),
    closedAt: null,
  };
}

function routes(active: WorldServiceSessionRecord | null) {
  const openVisit = vi.fn(async () => {
    throw new Error("/pc must not create an independent world-service visit");
  });
  const definitions = createWorldServiceWhatsAppRoutes({
    players: {
      resolvePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
      ),
    },
    world: {
      getLocation: vi.fn(async () =>
        ok({
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
          enteredAt: new Date("2026-09-07T10:00:00.000Z"),
          requiresRelocation: false,
          relocationAreaId: null,
          connections: [],
        }),
      ),
    },
    sessions: {
      openVisit,
      loadActiveSession: vi.fn(async () => ok(active)),
      closeVisit: vi.fn(),
    },
  });
  const pc = definitions.find((definition) => definition.command === "pc");
  if (pc === undefined) throw new Error("Missing /pc route");
  return { pc, openVisit };
}

describe("Pokémon Center PC nesting", () => {
  it("rejects /pc outside an active Pokémon Center visit", async () => {
    const fixture = routes(null);

    const result = await fixture.pc.handler.handle(context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ACTION_INVALID" },
    });
    expect(fixture.openVisit).not.toHaveBeenCalled();
  });

  it("opens the PC screen inside the existing Center session without consuming another scene proof", async () => {
    const fixture = routes(centerSession(4n));

    const result = await fixture.pc.handler.handle(context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.openVisit).not.toHaveBeenCalled();
    expect(result.value.resultRefId).toBe(SESSION_ID);
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗣𝗖 𝗣𝗢𝗞É𝗠𝗢𝗡");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "4",
    });
  });
});
