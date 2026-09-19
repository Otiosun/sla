import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const SESSION_ID = "00000000-0000-4000-8000-000000005102";

function context(): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000005103",
    correlationId: "00000000-0000-4000-8000-000000005104",
    causationId: "00000000-0000-4000-8000-000000005103",
    idempotencyKey: "inbox:baileys:mart-items-01",
    message: {
      provider: "baileys",
      externalMessageId: "mart-items-01",
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000005101@g.us",
      occurredAt: "2026-09-08T06:30:00.000Z",
      text: "/itens",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function session(): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: "00000000-0000-4000-8000-000000005105",
    serviceKind: "POKEMART",
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000005106",
    expectedReplyOutboxIdempotencyKey: null,
    expectedReplyExternalMessageId: null,
    revision: 7n,
    createdAt: new Date("2026-09-08T06:20:00.000Z"),
    updatedAt: new Date("2026-09-08T06:25:00.000Z"),
    closedAt: null,
  };
}

describe("Poké Mart read-only items command", () => {
  it("shows the full catalog without creating a purchase reply prompt", async () => {
    const routes = createWorldServiceWhatsAppRoutes({
      players: {
        resolvePlayer: vi.fn(async () =>
          ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
        ),
      },
      world: { getLocation: vi.fn() },
      sessions: {
        openVisit: vi.fn(),
        loadActiveSession: vi.fn(async () => ok(session())),
        closeVisit: vi.fn(),
      },
    });
    const route = routes.find((definition) => definition.command === "itens");
    expect(route).toBeDefined();
    if (route === undefined) return;

    const result = await route.handler.handle(context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outgoing = result.value.outgoing[0];
    expect(outgoing?.payload.text).toContain("𝗣𝗥𝗔𝗧𝗘𝗟𝗘𝗜𝗥𝗔𝗦");
    expect(outgoing?.payload.text).toContain("`01` Poké Ball · *₽200*");
    expect(outgoing?.payload.text).toContain("`16` X Sp. Def · *₽350*");
    expect(outgoing?.payload.worldServicePrompt).toBeUndefined();
    expect(outgoing?.idempotencyKey).toContain(":mart:items");
  });
});
