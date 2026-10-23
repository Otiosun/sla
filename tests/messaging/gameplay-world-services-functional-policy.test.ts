import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import { capabilitiesForWorldGroupSetup } from "../../src/modules/community/world-group-setup.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER = createPlayerId();
const SESSION = "00000000-0000-4000-8000-000000007301";
const ATTEMPT = "00000000-0000-4000-8000-000000007302";

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000007303",
    correlationId: "00000000-0000-4000-8000-000000007304",
    causationId: "00000000-0000-4000-8000-000000007303",
    idempotencyKey: `world-handler:${text}`,
    message: {
      provider: "baileys",
      externalMessageId: `world-${text}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363900073@g.us",
      occurredAt: "2026-10-23T12:00:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function setup(input: { readonly mart?: boolean; readonly group?: boolean } = {}) {
  const resolvePlayer = vi.fn(async () => ok({ playerId: PLAYER, state: "COMPLETE" }));
  const loadActiveSession = vi.fn(async () =>
    ok(
      input.mart
        ? { sessionId: SESSION, serviceKind: "POKEMART", revision: 3n }
        : null,
    ),
  );
  const attempt = vi.fn(async () =>
    ok({
      attemptId: ATTEMPT,
      playerId: PLAYER,
      areaId: "00000000-0000-4000-8000-000000007305",
      fishingPointName: "Rio dos Arrozais",
      attemptNo: 1,
      dailyLimit: 5,
      remainingAttempts: 4,
      roll: 8,
      rarity: null,
      replayed: false,
      encounter: null,
    }),
  );
  const routes = createWorldServiceWhatsAppRoutes({
    players: { resolvePlayer },
    world: { getLocation: vi.fn() },
    sessions: {
      openVisit: vi.fn(),
      loadActiveSession,
      closeVisit: vi.fn(),
    },
    fishing: { attempt },
  } as never).filter((route) => route.command === "comprar" || route.command === "pescar");
  const gate = new RuntimeCommandPolicyGate({
    community: {
      resolveChat: async () =>
        input.group === false
          ? { known: false as const, groupId: null, role: null, capabilities: [] }
          : {
              known: true as const,
              groupId: "00000000-0000-4000-8000-000000007306",
              role: "GAME" as const,
              capabilities: capabilitiesForWorldGroupSetup("GAME", []),
            },
    },
    players: { resolvePlayer },
    access: {
      load: async () => ({
        playerId: PLAYER,
        status: "ACTIVE" as const,
        approvedReviewId: "00000000-0000-4000-8000-000000007307",
        revision: 1,
      }),
    },
    admins: { capabilitiesFor: async () => [] },
  });
  return { router: new MessageRouter(routes, gate), attempt, loadActiveSession };
}

describe("world services through real GAME handlers and policy", () => {
  it("requires an active Poké Mart visit before opening /comprar catalog", async () => {
    const outside = setup();
    expect(await outside.router.dispatch(context("/comprar"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    const inside = setup({ mart: true });
    const result = await inside.router.dispatch(context("/comprar"));
    expect(result).toMatchObject({
      ok: true,
      value: { resultRefType: "WORLD_SERVICE_SESSION", resultRefId: SESSION },
    });
    if (!result.ok || result.value === null) throw new Error("Expected Poké Mart catalog");
    expect(result.value.outgoing[0]?.payload.text).toContain("Potion");
  });

  it("routes one eligible /pescar action and rejects it inside a Mart", async () => {
    const openWorld = setup();
    expect(await openWorld.router.dispatch(context("/pescar"))).toMatchObject({
      ok: true,
      value: { resultRefType: "FISHING_ATTEMPT", resultRefId: ATTEMPT },
    });
    expect(openWorld.attempt).toHaveBeenCalledWith({
      playerId: PLAYER,
      idempotencyKey: "world-handler:/pescar",
    });
    const insideMart = setup({ mart: true });
    expect(await insideMart.router.dispatch(context("/pescar"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(insideMart.attempt).not.toHaveBeenCalled();
  });

  it("rejects protected commands from unknown groups before touching domain ports", async () => {
    const unknown = setup({ group: false });
    expect(await unknown.router.dispatch(context("/pescar"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(await unknown.router.dispatch(context("/comprar"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(unknown.attempt).not.toHaveBeenCalled();
    expect(unknown.loadActiveSession).not.toHaveBeenCalled();
  });
});
