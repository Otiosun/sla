import { describe, expect, it, vi } from "vitest";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { ok } from "../../src/shared-kernel/result.js";

const owner = "33333333-3333-4333-8333-333333333333";
const itemId = "22222222-2222-4222-8222-222222222222";
const data = {
  requestId: "44444444-4444-4444-8444-444444444444",
  playerId: "11111111-1111-4111-8111-111111111111",
  sku: "MASTER" as const,
  quantity: 2,
  reason: "Entrega manual de Master Balls verificada.",
};

function make(stage = true, published = true, allowedOwner = true, duplicate = false) {
  let alreadyApplied = false;
  const apply = vi.fn(async () => {
    alreadyApplied = true;
    return { id: owner, status: "APPLIED" };
  });
  const prepare = vi.fn(async () => ({
    operation: { id: owner, status: alreadyApplied ? "APPLIED" : "READY" },
    replayed: alreadyApplied,
  }));
  const items = published ? [
    { itemId, slug: "master-ball", displayName: "Master Ball" },
    ...(duplicate ? [{ itemId: owner, slug: "master-ball", displayName: "Master Ball Duplicate" }] : []),
  ] : [];
  const instance = new PlayerPortalHttpHandler({
    sessions: { verify: () => ok({ provider: "baileys", externalId: "test@s.whatsapp.net" }) },
    admin: { resolvePrincipal: async () => ({ principalId: owner }), capabilitiesFor: async () => ["central.view"] },
    adminTeam: { isOwner: async () => allowedOwner },
    adminRewardCatalog: { get: async () => ({ items }) },
    adminMutations: { prepareMutation: prepare, apply },
    ...(stage ? { premiumDelivery: {} } : {}),
  } as unknown as ConstructorParameters<typeof PlayerPortalHttpHandler>[0]);

  const call = (method: "GET" | "POST", body?: unknown) => instance.handle(new Request(
    "https://staging.invalid/v1/hub/admin/premium/delivery/packs/master", {
      method,
      headers: {
        cookie: "__Host-pokemon_hub_session=test-token",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  ));
  return { call, prepare, apply };
}

describe("MASTER commercial pack: published catalog and manual grant", () => {
  it("fails closed when unavailable, ambiguous, not owner, or Premium staging is not mounted", async () => {
    const absent = make(true, false);
    expect(await (await absent.call("GET")).json()).toMatchObject({ available: false, item: null });
    expect((await absent.call("POST", data)).status).toBe(409);
    expect(absent.prepare).not.toHaveBeenCalled();
    const dup = make(true, true, true, true);
    expect(await (await dup.call("GET")).json()).toMatchObject({ available: false, item: null });
    expect((await dup.call("POST", data)).status).toBe(409);
    expect(dup.apply).not.toHaveBeenCalled();
    const normal = make(false);
    expect((await normal.call("GET")).status).toBe(503);
    expect((await normal.call("POST", data)).status).toBe(503);
    expect(normal.apply).not.toHaveBeenCalled();
    const nonOwner = make(true, true, false);
    expect((await nonOwner.call("GET")).status).toBe(403);
    expect((await nonOwner.call("POST", data)).status).toBe(403);
    expect(nonOwner.apply).not.toHaveBeenCalled();
  });

  it("uses exact published item identity, no payment field, strict SKU and quantity", async () => {
    const x = make();
    expect((await x.call("GET")).status).toBe(200);
    for (const invalid of [
      { ...data, paid: true },
      { ...data, itemId },
      { ...data, sku: "P-U" },
      { ...data, quantity: 21 },
      { ...data, quantity: 0 },
    ]) {
      expect((await x.call("POST", invalid)).status).toBe(400);
    }
    expect(x.prepare).not.toHaveBeenCalled();
    expect((await x.call("POST", data)).status).toBe(201);
    expect(x.prepare).toHaveBeenCalledWith(expect.objectContaining({
      operationType: "inventory.adjust",
      input: { playerId: data.playerId, itemId, delta: "2" },
      idempotencyKey: "premium-pack:MASTER:" + data.requestId,
    }));
    expect(x.apply).toHaveBeenCalledTimes(1);
  });

  it("reuses the operation for identical requestId instead of confirming a new grant", async () => {
    const x = make();
    const first = await x.call("POST", data);
    const second = await x.call("POST", data);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      applied: true, replayed: true, operationId: owner,
      playerId: data.playerId, sku: "MASTER", itemId, quantity: 2,
    });
    // AdminService.apply returns APPLIED without re-executing the effect; here it is a mock.
    expect(x.prepare).toHaveBeenCalledTimes(2);
  });
});
