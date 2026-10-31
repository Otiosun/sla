import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EntitlementService } from "../../src/modules/entitlements/service.js";
import { PremiumEntitlementFulfillmentService } from "../../src/modules/premium-orders/entitlement-fulfillment-service.js";
import { PremiumOrderService } from "../../src/modules/premium-orders/service.js";
import { ManualPremiumDeliveryService } from "../../src/modules/premium-orders/manual-delivery-service.js";
import { PremiumDeliveryCaseService } from "../../src/modules/premium-orders/manual-delivery-case-service.js";
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
  throw new Error(
    "Premium integration tests must use localhost PostgreSQL, never an external database",
  );
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
      "premium_delivery_case_events",
      "premium_delivery_cases",
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
        getSelf: async (_identity: ExternalIdentity) => ok({ playerId } as PlayerPortalSelfView),
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
      // Archived workflow is exercised only in this disposable historical test.
      allowLegacyPremiumOrders: true,
      premiumRead: {
        orders,
        entitlements,
        fulfillment: new PremiumEntitlementFulfillmentService(
          new PostgresPremiumOrderRepository(pool),
          entitlements,
        ),
      },
      premiumSupport: new PremiumSupportService(pool),
      premiumDelivery: new ManualPremiumDeliveryService(pool, entitlements),
      premiumCases: new PremiumDeliveryCaseService(pool),
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

  it("keeps archived payment and checkout paths NOT_FOUND for all sessions, with no writes", async () => {
    const id = randomUUID();
    const oldRoutes = [
      ["/v1/hub/player/premium/orders", { requestId: id, items: [{ sku: "2XP", quantity: 2 }] }],
      [`/v1/hub/admin/premium/orders/${id}/approve`, { requestId: id }],
      [`/v1/hub/admin/premium/orders/${id}/deliver`, { requestId: id }],
    ] as const;
    for (const [path, payload] of oldRoutes) {
      for (const cookie of [undefined, playerCookie, ownerCookie]) {
        const response = await handler.handle(request(path, "POST", payload, cookie));
        expect(response.status, `archived route ${path}, session=${cookie ? "present" : "absent"}`).toBe(404);
      }
    }
    const counts = await pool.query<{ orders: string; payments: string; grants: string }>(
      `SELECT (SELECT count(*)::text FROM premium_orders) AS orders,
              (SELECT count(*)::text FROM premium_payment_events) AS payments,
              (SELECT count(*)::text FROM entitlement_grants) AS grants`,
    );
    expect(counts.rows[0]).toEqual({ orders: "0", payments: "0", grants: "0" });
  });

  it("serves manual owner-only delivery over real loopback HTTP, leaving checkout disabled", async () => {
    // The HTTP listener is only bound to loopback in this disposable runner.
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of incoming) chunks.push(chunk as Uint8Array);
        const payload = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
          } else if (typeof value === "string") headers.set(key, value);
        }
        const forwarded = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers,
          ...(payload.byteLength > 0 ? { body: new Uint8Array(payload) } : {}),
        });
        const response = await handler.handle(forwarded);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })().catch(() => {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No loopback listener");
      const wire = (path: string, body: unknown, cookie?: string) =>
        fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST",
          headers: {
            ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const obsolete = "/v1/hub/player/premium/orders";
      const oldBody = { requestId: randomUUID(), items: [{ sku: "2XP", quantity: 2 }] };
      expect((await wire(obsolete, oldBody)).status).toBe(404);
      expect((await wire(obsolete, oldBody, playerCookie)).status).toBe(404);

      const path = "/v1/hub/admin/premium/delivery";
      const payload = {
        requestId: randomUUID(),
        playerId,
        sku: "2XP",
        quantity: 2,
        reason: "Entrega registrada manualmente em ambiente de teste isolado.",
      };
      expect((await wire(path, payload)).status).toBe(401);
      expect((await wire(path, payload, nonOwnerCookie)).status).toBe(403);
      const granted = await wire(path, payload, ownerCookie);
      expect(granted.status).toBe(201);
      expect(await granted.json()).toMatchObject({
        applied: true,
        replayed: false,
        entitlement: { entitlementKey: "XP_2X", currentlyActive: true },
      });
      const replay = await wire(path, payload, ownerCookie);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ replayed: true, requestId: payload.requestId });
      const counts = await pool.query<{ orders: string; payments: string; grants: string }>(
        `SELECT (SELECT count(*)::text FROM premium_orders) AS orders,
                (SELECT count(*)::text FROM premium_payment_events) AS payments,
                (SELECT count(*)::text FROM entitlement_grants) AS grants`,
      );
      expect(counts.rows[0]).toEqual({ orders: "0", payments: "0", grants: "1" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("lets owner deliver XP 2x directly without payment, with catalog, history and safe replay", async () => {
    const deliveryPath = "/v1/hub/admin/premium/delivery";
    const catalogPath = "/v1/hub/admin/premium/delivery/catalog";
    const requestId = randomUUID();
    const input = {
      requestId,
      playerId,
      sku: "2XP",
      quantity: 2,
      reason: "Entrega manual feita após confirmação externa pelo administrador.",
    };
    expect((await handler.handle(request(deliveryPath, "POST", input))).status).toBe(401);
    expect((await handler.handle(request(deliveryPath, "POST", input, nonOwnerCookie))).status).toBe(403);
    expect((await handler.handle(request(catalogPath, "GET", undefined, nonOwnerCookie))).status).toBe(403);

    const catalog = await handler.handle(request(catalogPath, "GET", undefined, ownerCookie));
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      products: [
        { sku: "2XP", maxQuantity: 52, durationSecondsPerUnit: 604800 },
        { sku: "LUCK", maxQuantity: 1, grantModel: "PERMANENT", entitlementKey: "CAPTURE_LUCK_2X" },
      ],
    });
    const wrong = await handler.handle(request(deliveryPath, "POST", {
      ...input, totalCents: 1,
    }, ownerCookie));
    expect(wrong.status).toBe(400);
    expect((await handler.handle(request(deliveryPath, "POST", {
      ...input, sku: "POKEMON_PACKAGE",
    }, ownerCookie))).status).toBe(404);

    const first = await handler.handle(request(deliveryPath, "POST", input, ownerCookie));
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { entitlement: { expiresAt: string; startsAt: string } };
    expect(firstBody).toMatchObject({
      applied: true,
      replayed: false,
      requestId,
      entitlement: { entitlementKey: "XP_2X", currentlyActive: true },
    });
    expect(new Date(firstBody.entitlement.expiresAt).getTime() -
      new Date(firstBody.entitlement.startsAt).getTime()).toBe(14 * 24 * 60 * 60 * 1000);

    const repeat = await handler.handle(request(deliveryPath, "POST", input, ownerCookie));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ applied: true, replayed: true, requestId });
    expect((await handler.handle(request(deliveryPath, "POST", {
      ...input, quantity: 3,
    }, ownerCookie))).status).toBe(409);

    const history = await handler.handle(request(
      `/v1/hub/admin/premium/players/${playerId}/deliveries`, "GET", undefined, ownerCookie,
    ));
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      deliveries: [{
        requestId, sku: "2XP", quantity: 2, actorPrincipalId: ownerPrincipalId,
        entitlementKey: "XP_2X",
      }],
    });

    const counts = await pool.query<{
      grants: string; orders: string; payments: string; fulfillments: string; multiplier: number;
    }>(`SELECT (SELECT count(*)::text FROM entitlement_grants) AS grants,
      (SELECT count(*)::text FROM premium_orders) AS orders,
      (SELECT count(*)::text FROM premium_payment_events) AS payments,
      (SELECT count(*)::text FROM premium_fulfillment_events) AS fulfillments,
      pokemon_battle_xp_multiplier_for($1::uuid, now()) AS multiplier`, [playerId]);
    expect(counts.rows[0]).toEqual({
      grants: "1", orders: "0", payments: "0", fulfillments: "0", multiplier: 2,
    });
  });

  it("delivers permanent Luck 2x only by owner, with safe replay and no payment automation", async () => {
    const deliveryPath = "/v1/hub/admin/premium/delivery";
    const requestId = randomUUID();
    const payload = {
      requestId, playerId, sku: "LUCK", quantity: 1,
      reason: "Benefício confirmado manualmente após pagamento externo.",
    };
    expect((await handler.handle(request(deliveryPath, "POST", payload, nonOwnerCookie))).status).toBe(403);
    const applied = await handler.handle(request(deliveryPath, "POST", payload, ownerCookie));
    expect(applied.status).toBe(201);
    expect(await applied.json()).toMatchObject({
      applied: true, replayed: false,
      entitlement: { entitlementKey: "CAPTURE_LUCK_2X", grantModel: "PERMANENT", currentlyActive: true },
    });
    const replay = await handler.handle(request(deliveryPath, "POST", payload, ownerCookie));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ applied: true, replayed: true });
    expect((await handler.handle(request(deliveryPath, "POST", {
      ...payload, quantity: 2,
    }, ownerCookie))).status).toBe(409);
    const data = await pool.query<{
      grants: string; orders: string; payments: string; multiplier: number;
    }>(`SELECT (SELECT count(*)::text FROM entitlement_grants) AS grants,
       (SELECT count(*)::text FROM premium_orders) AS orders,
       (SELECT count(*)::text FROM premium_payment_events) AS payments,
       premium_capture_luck_multiplier_for($1::uuid, now())::int AS multiplier`, [playerId]);
    expect(data.rows[0]).toEqual({ grants: "1", orders: "0", payments: "0", multiplier: 2 });
  });

  it("tracks an owner-only commercial gamepass case and its review without any grant or payment", async () => {
    const caseId=randomUUID(),eventId=randomUUID(),changeId=randomUUID(),doneId=randomUUID();
    const api="/v1/hub/admin/premium/delivery/cases";
    const payload={
      caseId,eventId,playerId,sku:"GEN",quantity:1,
      note:"Direito de criar espécie original, aguarda análise da equipe e arte do jogador.",
    };
    expect((await handler.handle(request(api,"POST",payload))).status).toBe(401);
    expect((await handler.handle(request(api,"POST",payload,nonOwnerCookie))).status).toBe(403);
    expect((await handler.handle(request(api,"POST",{...payload,paid:true},ownerCookie))).status).toBe(400);
    const catalog=await handler.handle(request(api+"/catalog","GET",undefined,ownerCookie));
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({products:expect.arrayContaining([
      expect.objectContaining({sku:"GEN",maxQuantity:20}),
      expect.objectContaining({sku:"EGG:ESPECIAL",maxQuantity:20}),
    ])});
    const opened=await handler.handle(request(api,"POST",payload,ownerCookie));
    expect(opened.status).toBe(201);
    expect(await opened.json()).toMatchObject({
      replayed:false,case:{id:caseId,playerId,sku:"GEN",state:"OPEN",revision:0},
    });
    const repeat=await handler.handle(request(api,"POST",payload,ownerCookie));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({replayed:true,case:{id:caseId}});
    expect((await handler.handle(request(api,"POST",{...payload,quantity:2},ownerCookie))).status).toBe(409);
    const review={caseId,eventId:changeId,expectedRevision:0,nextState:"IN_PROGRESS",
      attested:false,note:"Projeto do Pokémon Gênesis sob análise de equilíbrio e publicação."};
    const reviewRes=await handler.handle(request(api+"/"+caseId+"/transition","POST",review,ownerCookie));
    expect(reviewRes.status).toBe(200);
    expect(await reviewRes.json()).toMatchObject({case:{state:"IN_PROGRESS",revision:1}});
    expect((await handler.handle(request(api+"/"+caseId+"/transition","POST",review,ownerCookie))).status).toBe(200);
    expect((await handler.handle(request(api+"/"+caseId+"/transition","POST",
      {...review,eventId:randomUUID()},ownerCookie))).status).toBe(409);
    const close={caseId,eventId:doneId,expectedRevision:1,nextState:"CLOSED",
      attested:true,note:"Entrega concluída manualmente e verificada pelo responsável; registros de publicação conferidos."};
    expect((await handler.handle(request(api+"/"+caseId+"/transition","POST",
      {...close,attested:false},ownerCookie))).status).toBe(400);
    const finished=await handler.handle(request(api+"/"+caseId+"/transition","POST",close,ownerCookie));
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({case:{state:"CLOSED",revision:2}});
    expect((await handler.handle(request(api+"/"+caseId+"/transition","POST",
      {...review,eventId:randomUUID(),expectedRevision:2},ownerCookie))).status).toBe(409);
    const timeline=await handler.handle(request(api+"/"+caseId+"/events","GET",undefined,ownerCookie));
    expect(timeline.status).toBe(200);
    const body=await timeline.json() as {events:{nextState:string}[]};
    expect(body.events.map(e=>e.nextState)).toEqual(["OPEN","IN_PROGRESS","CLOSED"]);
    const list=await handler.handle(request(api+"?playerId="+playerId,"GET",undefined,ownerCookie));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({cases:[{id:caseId,sku:"GEN",state:"CLOSED"}]});
    const state=await pool.query<{cases:string,events:string,payments:string,grants:string,orders:string}>(
      `SELECT (SELECT count(*)::text FROM premium_delivery_cases) AS cases,
              (SELECT count(*)::text FROM premium_delivery_case_events) AS events,
              (SELECT count(*)::text FROM premium_payment_events) AS payments,
              (SELECT count(*)::text FROM entitlement_grants) AS grants,
              (SELECT count(*)::text FROM premium_orders) AS orders`);
    expect(state.rows[0]).toEqual({cases:"1",events:"3",payments:"0",grants:"0",orders:"0"});
  });

});
