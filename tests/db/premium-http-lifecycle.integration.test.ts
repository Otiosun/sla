import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EntitlementService } from "../../src/modules/entitlements/service.js";
import { PremiumEntitlementFulfillmentService } from "../../src/modules/premium-orders/entitlement-fulfillment-service.js";
import { PremiumOrderService } from "../../src/modules/premium-orders/service.js";
import { PremiumSupportService } from "../../src/modules/premium-support/service.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { HubSessionTokenService } from "../../src/modules/player-portal/session-token-service.js";
import type { PlayerPortalSelfView } from "../../src/modules/player-portal/read-service.js";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEntitlementRepository } from "../../src/platform/entitlements/postgres-entitlement-repository.js";
import { PostgresPremiumOrderRepository } from "../../src/platform/premium-orders/postgres-premium-order-repository.js";
import { ok } from "../../src/shared-kernel/result.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for disposable PostgreSQL tests");
  return value;
})();
if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
  throw new Error("Refusing Premium HTTP integration test without disposable DB authorization");
}
const origin = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(origin.hostname)) {
  throw new Error("Premium integration tests must use localhost PostgreSQL, never an external database");
}

const ownerIdentity: ExternalIdentity = {
  provider: "baileys",
  externalId: "5511999999998@s.whatsapp.net",
};
const playerIdentity: ExternalIdentity = {
  provider: "baileys",
  externalId: "5511999999997@s.whatsapp.net",
};
const otherAdminIdentity: ExternalIdentity = {
  provider: "baileys",
  externalId: "5511999999996@s.whatsapp.net",
};
const ownerPrincipalId = "11111111-1111-4111-8111-111111111111";
const otherPrincipalId = "22222222-2222-4222-8222-222222222222";
const COOKIE = "__Host-pokemon_hub_session";

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("Premium HTTP lifecycle with real isolated PostgreSQL", () => {
  const dbName = `pokemon_premium_http_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let handler: PlayerPortalHttpHandler;
  let playerId: string;
  let sessions: HubSessionTokenService;
  let playerCookie: string;
  let ownerCookie: string;
  let nonOwnerCookie: string;

  const route = (path: string) => `https://staging.test${path}`;

  function request(path: string, method: "GET" | "POST", body?: unknown, cookie?: string): Request {
    return new Request(route(path), {
      method,
      headers: {
        ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 10 });
    await runMigrations(pool, { appliedBy: "premium-http-disposable-ci-only" });
  }, 60_000);

  beforeEach(async () => {
    for (const table of [
      "premium_support_events",
      "premium_fulfillment_events",
      "premium_payment_events",
      "premium_order_items",
      "premium_orders",
      "entitlement_grants",
      "player_entitlements",
      "player_identities",
      "player_profiles",
      "onboarding_states",
      "trainer_progression",
      "players",
    ]) {
      await pool.query(`DELETE FROM ${table}`);
    }

    playerId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    sessions = new HubSessionTokenService({ signingKey: new Uint8Array(32).fill(19) });

    const token = (identity: ExternalIdentity): string => {
      const issued = sessions.issue(identity);
      if (!issued.ok) throw new Error("Could not create a synthetic Hub session");
      return issued.value.token;
    };
    playerCookie = token(playerIdentity);
    ownerCookie = token(ownerIdentity);
    nonOwnerCookie = token(otherAdminIdentity);

    const orders = new PremiumOrderService(new PostgresPremiumOrderRepository(pool));
    const entitlements = new EntitlementService(new PostgresEntitlementRepository(pool));

    // Non-Premium dependencies are irrelevant to these routes, and cannot
    // activate the game or WhatsApp. Premium services and DB are REAL.
    const dependencies = {
      sessions,
      player: {
        getSelf: async (_identity: ExternalIdentity) =>
          ok({ playerId } as PlayerPortalSelfView),
      },
      admin: {
        resolvePrincipal: async (identity: ExternalIdentity) =>
          identity.externalId === ownerIdentity.externalId
            ? { principalId: ownerPrincipalId }
            : identity.externalId === otherAdminIdentity.externalId
              ? { principalId: otherPrincipalId }
              : null,
        capabilitiesFor: async (identity: ExternalIdentity) =>
          identity.externalId === playerIdentity.externalId ? [] : ["central.view"],
      },
      adminTeam: {
        isOwner: async (principalId: string) => principalId === ownerPrincipalId,
      },
      premiumRead: {
        orders,
        entitlements,
        fulfillment: new PremiumEntitlementFulfillmentService(
          new PostgresPremiumOrderRepository(pool), entitlements,
        ),
      },
      premiumSupport: new PremiumSupportService(pool),
    } as unknown as ConstructorParameters<typeof PlayerPortalHttpHandler>[0];
    handler = new PlayerPortalHttpHandler(dependencies);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminPool.end();
    }
  }, 60_000);

  it("creates a PENDING 2XP order and returns one idempotent replay without payment", async () => {
    const path = "/v1/hub/player/premium/orders";
    const payload = {
      requestId: randomUUID(),
      items: [{ sku: "2XP", quantity: 2 }],
    };
    expect((await handler.handle(request(path, "POST", payload))).status).toBe(401);
    expect((await handler.handle(request(path, "POST", { ...payload, playerId }, playerCookie))).status).toBe(400);
    expect((await handler.handle(request(path, "POST", {
      ...payload, amountCents: 1,
    }, playerCookie))).status).toBe(400);

    const created = await handler.handle(request(path, "POST", payload, playerCookie));
    expect(created.status).toBe(201);
    const initial = await created.json() as {
      order: { id: string; status: string; humanId: string; revision: string };
    };
    expect(initial).toMatchObject({
      replayed: false, paymentStatus: "PENDING",
      order: { status: "PENDING", playerId, totalCents: 8000, currency: "BRL" },
    });
    const replay = await handler.handle(request(path, "POST", payload, playerCookie));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      replayed: true, order: { id: initial.order.id, status: "PENDING" },
    });

    const counts = await pool.query<{
      orders: string; payments: string; grants: string;
    }>(`SELECT
      (SELECT count(*)::text FROM premium_orders) AS orders,
      (SELECT count(*)::text FROM premium_payment_events) AS payments,
      (SELECT count(*)::text FROM entitlement_grants) AS grants`);
    expect(counts.rows[0]).toEqual({ orders: "1", payments: "0", grants: "0" });
  });

  it("requires owner, payment before delivery, then grants precisely 14 days once", async () => {
    const created = await handler.handle(request(
      "/v1/hub/player/premium/orders",
      "POST",
      { requestId: randomUUID(), items: [{ sku: "2XP", quantity: 2 }] },
      playerCookie,
    ));
    expect(created.status).toBe(201);
    const { order } = await created.json() as {
      order: { id: string; humanId: string; revision: string };
    };
    const approvePath = `/v1/hub/admin/premium/orders/${order.id}/approve`;
    const deliverPath = `/v1/hub/admin/premium/orders/${order.id}/deliver`;
    const approvalId = randomUUID();
    const deliveryId = randomUUID();
    const paymentInput = {
      requestId: approvalId,
      humanId: order.humanId,
      expectedRevision: order.revision,
      reason: "Pagamento confirmado manualmente pelo proprietário de teste.",
      confirmed: true,
    };

    expect((await handler.handle(request(approvePath, "POST", paymentInput))).status).toBe(401);
    expect((await handler.handle(request(approvePath, "POST", paymentInput, nonOwnerCookie))).status).toBe(403);
    expect((await handler.handle(request(deliverPath, "POST", {
      ...paymentInput, requestId: deliveryId,
    }, ownerCookie))).status).toBe(409);
    expect((await handler.handle(request(approvePath, "POST", {
      ...paymentInput, amountCents: 1,
    }, ownerCookie))).status).toBe(400);

    const paid = await handler.handle(request(approvePath, "POST", paymentInput, ownerCookie));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({
      operation: "PAYMENT_APPROVED", delivered: false, replayed: false,
      order: { id: order.id, status: "PAID", totalCents: 8000 },
    });
    const payAgain = await handler.handle(request(approvePath, "POST", paymentInput, ownerCookie));
    expect(payAgain.status).toBe(200);
    expect(await payAgain.json()).toMatchObject({
      operation: "PAYMENT_APPROVED", replayed: true,
    });
    expect((await handler.handle(request(approvePath, "POST", {
      ...paymentInput, requestId: randomUUID(),
    }, ownerCookie))).status).toBe(409);

    const preDeliver = await pool.query<{ payments: string; grants: string; support: string }>(`
      SELECT (SELECT count(*)::text FROM premium_payment_events) AS payments,
        (SELECT count(*)::text FROM entitlement_grants) AS grants,
        (SELECT count(*)::text FROM premium_support_events) AS support`);
    expect(preDeliver.rows[0]).toEqual({ payments: "1", grants: "0", support: "1" });

    const deliveryInput = {
      ...paymentInput,
      requestId: deliveryId,
      expectedRevision: "1",
      reason: "Entrega do XP aprovada e confirmada em ambiente descartável.",
    };
    const delivered = await handler.handle(request(deliverPath, "POST", deliveryInput, ownerCookie));
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({
      operation: "2XP_DELIVERED", delivered: true, replayed: false,
      order: { id: order.id, status: "APPLIED" },
    });

    const reDelivered = await handler.handle(request(deliverPath, "POST", deliveryInput, ownerCookie));
    expect(reDelivered.status).toBe(200);
    expect(await reDelivered.json()).toMatchObject({
      operation: "2XP_DELIVERED", replayed: true,
    });
    const read = await handler.handle(request(
      `/v1/hub/admin/premium/players/${playerId}/orders`, "GET", undefined, ownerCookie,
    ));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      orders: [{ id: order.id, status: "APPLIED" }],
    });
    expect((await handler.handle(request(
      `/v1/hub/admin/premium/players/${playerId}/entitlements`,
      "GET", undefined, nonOwnerCookie,
    ))).status).toBe(403);

    const result = await pool.query<{
      starts_at: Date; expires_at: Date; payments: string;
      grants: string; fulfillments: string; support: string; multiplier: number;
    }>(`SELECT e.starts_at, e.expires_at,
      (SELECT count(*)::text FROM premium_payment_events) AS payments,
      (SELECT count(*)::text FROM entitlement_grants) AS grants,
      (SELECT count(*)::text FROM premium_fulfillment_events) AS fulfillments,
      (SELECT count(*)::text FROM premium_support_events) AS support,
      pokemon_battle_xp_multiplier_for($1::uuid, now()) AS multiplier
      FROM player_entitlements e
      WHERE e.player_id = $1 AND e.entitlement_key = 'XP_2X'`, [playerId]);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (!row) throw new Error("Premium entitlement row disappeared");
    expect(row.expires_at.getTime() - row.starts_at.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    expect(row).toMatchObject({
      payments: "1", grants: "1", fulfillments: "1", support: "2", multiplier: 2,
    });
  });
});
