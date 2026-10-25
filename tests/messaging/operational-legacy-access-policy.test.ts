import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";

function context(command: string): MessageHandlerContext {
  return {
    inboxMessageId: "travel-policy-inbox",
    correlationId: "00000000-0000-4000-8000-000000000031",
    causationId: "travel-policy-inbox",
    idempotencyKey: "travel-policy-action",
    message: {
      provider: "baileys",
      externalMessageId: "travel-policy-message",
      senderRef: "shadow-travel@s.whatsapp.net",
      chatRef: "shadow-travel@g.us",
      occurredAt: "2026-10-25T03:00:00.000Z",
      text: command,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function fixture(status: "ACTIVE" | "SUSPENDED" | "PENDING", state: "COMPLETE" | "NEW" = "COMPLETE") {
  const handlerResolve = vi.fn(async () => ok({ playerId: PLAYER_ID, state, created: false }));
  const authResolve = vi.fn(async () => ok({ playerId: PLAYER_ID, state, created: false }));
  const accessLoad = vi.fn(async () => ({
    playerId: PLAYER_ID,
    status,
    approvedReviewId: status === "PENDING" ? null : "00000000-0000-4000-8000-000000000051",
    revision: 2,
  }));
  const getLocation = vi.fn();
  const travel = vi.fn();
  const routes = createOperationalUxRoutes({
    registration: { resolvePlayer: handlerResolve },
    world: { getLocation, travel },
  } as never);
  const groupLookup = vi.fn(async () => ({
    known: false,
    groupId: null,
    role: null,
    capabilities: [],
  }));
  const gate = new RuntimeCommandPolicyGate({
    community: { resolveChat: groupLookup },
    players: { resolvePlayer: authResolve },
    access: { load: accessLoad },
    admins: { capabilitiesFor: vi.fn(async () => []) },
  } as never);
  return {
    routes,
    router: new MessageRouter(routes, gate),
    handlerResolve,
    authResolve,
    accessLoad,
    getLocation,
    travel,
    groupLookup,
  };
}

describe("legacy operational route access policy", () => {
  it("protects travel without applying group policy or blanket restrictions on queries and reception", () => {
    const f = fixture("ACTIVE");
    const travelRoute = f.routes.find((route) => route.command === "ir");
    expect(travelRoute?.policy).toEqual({
      allowedPlayerAccess: ["ACTIVE"],
      requiresMechanicalReady: true,
    });
    expect(travelRoute?.policy?.requiredGroupCapabilities).toBeUndefined();

    for (const command of [
      "menu",
      "registrar",
      "regioes",
      "regiao",
      "starters",
      "starter",
      "concluir",
      "perfil",
      "equipe",
      "colecao",
      "box",
      "pokemon",
      "inventario",
      "pokedex",
      "onde",
      "combate",
    ]) {
      expect(f.routes.find((route) => route.command === command)?.policy).toBeUndefined();
    }
  });

  it.each(["SUSPENDED", "PENDING"] as const)(
    "blocks %s before any travel-related handler or mutation runs",
    async (status) => {
      const f = fixture(status);
      const result = await f.router.dispatch(context("/ir 1"));
      expect(result).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
      expect(f.authResolve).toHaveBeenCalledTimes(1);
      expect(f.accessLoad).toHaveBeenCalledTimes(1);
      expect(f.handlerResolve).not.toHaveBeenCalled();
      expect(f.getLocation).not.toHaveBeenCalled();
      expect(f.travel).not.toHaveBeenCalled();
      expect(f.groupLookup).not.toHaveBeenCalled();
    },
  );

  it("blocks ACTIVE players with unfinished onboarding before travel", async () => {
    const f = fixture("ACTIVE", "NEW");
    const result = await f.router.dispatch(context("/ir 1"));
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(f.getLocation).not.toHaveBeenCalled();
    expect(f.travel).not.toHaveBeenCalled();
  });

});
