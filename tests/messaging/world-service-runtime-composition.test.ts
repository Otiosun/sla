import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000000c01";

function message(text: string): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: `world-runtime-${text}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: "120363000000000901@g.us",
    occurredAt: "2026-09-07T06:00:00.000Z",
    text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  };
}

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000c02",
    correlationId: "00000000-0000-4000-8000-000000000c03",
    causationId: "00000000-0000-4000-8000-000000000c02",
    idempotencyKey: "inbox:baileys:world-runtime",
    message: message(text),
  };
}

function openedPcSession(): WorldServiceSessionRecord {
  return {
    sessionId: "00000000-0000-4000-8000-000000000c04",
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: "PC",
    state: "OPEN",
    sceneProofId: null,
    expectedReplyOutboxIdempotencyKey: null,
    expectedReplyExternalMessageId: null,
    revision: 0n,
    createdAt: new Date("2026-09-07T06:00:00.000Z"),
    updatedAt: new Date("2026-09-07T06:00:00.000Z"),
    closedAt: null,
  };
}

describe("World Service runtime composition", () => {
  it("registers the protected facility routes in the operational router", () => {
    const composition = createOperationalMessagingComposition({} as Pool);

    expect(composition.router.classify(message("/pokemart"))).toEqual({
      command: "pokemart",
      sensitiveActionKey: null,
    });
    expect(composition.router.classify(message("/centropokemon"))).toEqual({
      command: "centropokemon",
      sensitiveActionKey: null,
    });
    expect(composition.router.classify(message("/pc"))).toEqual({
      command: "pc",
      sensitiveActionKey: null,
    });
    expect(composition.router.classify(message("/sair"))).toEqual({
      command: "sair",
      sensitiveActionKey: null,
    });
  });

  it("anchors the facility entry message to the opened session revision", async () => {
    const session = openedPcSession();
    const routes = createWorldServiceWhatsAppRoutes({
      players: {
        resolvePlayer: async () =>
          ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
      },
      world: {
        getLocation: async () =>
          ok({
            playerId: PLAYER_ID,
            contentReleaseId: "00000000-0000-4000-8000-000000000c05",
            areaId: AREA_ID,
            areaSlug: "zhoulia-central",
            areaDisplayName: "Centro de Zhoulia",
            regionId: "00000000-0000-4000-8000-000000000c06",
            regionSlug: "zhoulia",
            regionDisplayName: "Zhoulia",
            safePoint: true,
            revision: 0n,
            enteredAt: new Date("2026-09-07T05:00:00.000Z"),
            requiresRelocation: false,
            relocationAreaId: null,
            connections: [],
          }),
      },
      sessions: {
        openVisit: async () => ok(session),
        loadActiveSession: async () => ok(session),
        closeVisit: async () => ok({ ...session, state: "CLOSED" as const, closedAt: new Date() }),
      },
    });
    const pc = routes.find((route) => route.command === "pc");
    if (pc === undefined) throw new Error("PC route missing");

    const result = await pc.handler.handle(context("/pc"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "0",
    });
  });
});
