import { describe, expect, it, vi } from "vitest";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { ok } from "../../src/shared-kernel/result.js";

const selfId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const cookie = "__Host-pokemon_hub_session=valid-session";

function makeHandler(options: { enabled?: boolean; authenticated?: boolean } = {}) {
  const list = vi.fn(async (id: string) => [{
    playerId: id, entitlementKey: "XP_2X", grantModel: "TIMED",
    administrativeStatus: "ACTIVE", startsAt: "2026-10-22T12:00:00.000Z",
    expiresAt: "2026-10-29T12:00:00.000Z", revision: "1", currentlyActive: true,
  }]);
  const getSelf = vi.fn(async () => ok({ playerId: selfId }));
  const handler = new PlayerPortalHttpHandler({
    sessions: {
      verify: () => options.authenticated === false
        ? { ok: false, error: { code: "INVALID_SESSION" } }
        : { ok: true, value: { provider: "baileys", externalId: "5511999999999@s.whatsapp.net" } },
    },
    player: { getSelf },
    ...(options.enabled === false ? {} : {
      premiumRead: { entitlements: { listPlayerEntitlements: list } },
    }),
  } as unknown as ConstructorParameters<typeof PlayerPortalHttpHandler>[0]);
  return { handler, getSelf, list };
}

describe("self-service benefits: player identity isolation", () => {
  it("requires a signed session before reading any entitlement", async () => {
    const { handler, list, getSelf } = makeHandler();
    const response = await handler.handle(new Request("https://game.local/v1/hub/player/benefits"));
    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(getSelf).not.toHaveBeenCalled();
  });

  it("rejects a forged/expired signed session", async () => {
    const { handler, list } = makeHandler({ authenticated: false });
    const response = await handler.handle(new Request("https://game.local/v1/hub/player/benefits", {
      headers: { cookie },
    }));
    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("reads only the resolved player ID and returns the official entitlement state", async () => {
    const { handler, list, getSelf } = makeHandler();
    const response = await handler.handle(new Request("https://game.local/v1/hub/player/benefits", {
      headers: { cookie },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { entitlements: { playerId: string; entitlementKey: string }[] };
    expect(body.entitlements[0]?.entitlementKey).toBe("XP_2X");
    expect(body.entitlements[0]?.playerId).toBe(selfId);
    expect(getSelf).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(selfId);
  });

  it("does not allow arbitrary playerId selectors even when signed in", async () => {
    const { handler, list } = makeHandler();
    const response = await handler.handle(new Request(
      "https://game.local/v1/hub/player/benefits?playerId=" + otherId, {
        headers: { cookie },
      },
    ));
    expect(response.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it("fails closed when the premium repository was not opted in", async () => {
    const { handler } = makeHandler({ enabled: false });
    const response = await handler.handle(new Request("https://game.local/v1/hub/player/benefits", {
      headers: { cookie },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "BENEFITS_UNAVAILABLE" });
  });
});
