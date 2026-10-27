import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EntitlementService } from "../../src/modules/entitlements/service.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { ok } from "../../src/shared-kernel/result.js";
import { ManualPremiumDeliveryService } from "../../src/modules/premium-orders/manual-delivery-service.js";
import { PremiumDeliveryCaseService } from "../../src/modules/premium-orders/manual-delivery-case-service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEntitlementRepository } from "../../src/platform/entitlements/postgres-entitlement-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for manual Premium integration tests");
function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl as string);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("manual Premium grants via published 2XP and LUCK catalog", () => {
  const dbName = `pokemon_manual_premium_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let service: ManualPremiumDeliveryService;
  let playerId: string;
  const actorPrincipalId = randomUUID();

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "manual-premium-delivery-vitest" });
    service = new ManualPremiumDeliveryService(
      pool,
      new EntitlementService(new PostgresEntitlementRepository(pool)),
    );
  }, 30_000);

  beforeEach(async () => {
    await pool.query("DELETE FROM premium_delivery_case_events");
    await pool.query("DELETE FROM premium_delivery_cases");
    await pool.query("DELETE FROM entitlement_grants");
    await pool.query("DELETE FROM player_entitlements");
    await pool.query("DELETE FROM player_identities");
    await pool.query("DELETE FROM player_profiles");
    await pool.query("DELETE FROM onboarding_states");
    await pool.query("DELETE FROM trainer_progression");
    await pool.query("DELETE FROM players");
    playerId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("lists both products from the real catalog; never lists undefined bundles", async () => {
    const products = await service.catalog();
    const xp = products.find((p) => p.sku === "2XP");
    const luck = products.find((p) => p.sku === "LUCK");
    expect(xp).toMatchObject({
      sku: "2XP", entitlementKey: "XP_2X", grantModel: "TIMED",
      durationSecondsPerUnit: 604800, maxQuantity: 52,
    });
    expect(luck).toMatchObject({
      sku: "LUCK", entitlementKey: "CAPTURE_LUCK_2X", grantModel: "PERMANENT",
      durationSecondsPerUnit: null, maxQuantity: 1,
    });
    expect(products.some((p) => p.sku === "GEN" || p.sku === "TERA")).toBe(false);
  });

  it("grants XP 2x for 14 days once and replays duplicate submission without extra time", async () => {
    const requestId = randomUUID();
    const input = { requestId, playerId, sku: "2XP", quantity: 2,
      reason: "Pagamento conferido externamente pela equipe." };
    expect(await service.deliver(input, actorPrincipalId)).toMatchObject({
      kind: "APPLIED", replayed: false,
      entitlement: { entitlementKey: "XP_2X", grantModel: "TIMED" },
    });
    expect(await service.deliver(input, actorPrincipalId)).toMatchObject({
      kind: "APPLIED", replayed: true,
    });
    const entries = await service.history(playerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sku: "2XP", quantity: 2, requestId, actorPrincipalId, durationSeconds: 1209600,
    });
    const rows = await pool.query<{ days: number; grants: string }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - starts_at)) / 86400 AS days,
         (SELECT count(*)::text FROM entitlement_grants
          WHERE player_id = $1) AS grants
       FROM player_entitlements WHERE player_id = $1 AND entitlement_key = 'XP_2X'`,
      [playerId],
    );
    expect(Number(rows.rows[0]?.days)).toBe(14);
    expect(rows.rows[0]?.grants).toBe("1");
  });

  it("grants permanent LUCK once on retry without expiration, never claims payment", async () => {
    const requestId = randomUUID();
    const input = { requestId, playerId, sku: "LUCK", quantity: 1,
      reason: "Entregue após validação financeira fora do jogo." };
    const first = await service.deliver(input, actorPrincipalId);
    expect(first).toMatchObject({
      kind: "APPLIED", replayed: false,
      entitlement: { entitlementKey: "CAPTURE_LUCK_2X", grantModel: "PERMANENT",
        expiresAt: null },
    });
    const second = await service.deliver(input, actorPrincipalId);
    expect(second).toMatchObject({ kind: "APPLIED", replayed: true });
    const view = await service.history(playerId);
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ sku: "LUCK", requestId, actorPrincipalId });
    const rows = await pool.query<{ payments: string; orders: string }>(
      "SELECT (SELECT count(*)::text FROM premium_payment_events) AS payments, " +
        "(SELECT count(*)::text FROM premium_orders) AS orders",
    );
    expect(rows.rows[0]).toEqual({ payments: "0", orders: "0" });
  });


  it("tracks a human-operated GEN Gamepass case without granting Pokémon, items or entitlements", async () => {
    const cases = new PremiumDeliveryCaseService(pool);
    expect(cases.catalog().some((p) => p.sku === "GEN")).toBe(true);
    const caseId = randomUUID();
    const eventId = randomUUID();
    const opening = {
      caseId, eventId, playerId, sku: "GEN", quantity: 1,
      note: "Aguardando conceito e aprovação de espécie pelo proprietário.",
    };
    const first = await cases.open(opening, actorPrincipalId);
    expect(first).toMatchObject({
      kind: "APPLIED", replayed: false,
      case: { id: caseId, state: "OPEN", revision: 0, sku: "GEN" },
    });
    expect(await cases.open(opening, actorPrincipalId)).toMatchObject({
      kind: "APPLIED", replayed: true,
    });
    expect(await cases.open({ ...opening, quantity: 2 }, actorPrincipalId)).toMatchObject({
      kind: "CONFLICT", code: "IDEMPOTENCY_CONFLICT",
    });
    expect(await cases.list(playerId)).toHaveLength(1);
    expect(await cases.timeline(caseId)).toHaveLength(1);

    const transition = {
      caseId, eventId: randomUUID(), expectedRevision: 0,
      nextState: "IN_PROGRESS" as const,
      note: "Documentação recebida para revisão.", attested: false,
    };
    expect(await cases.advance(transition, actorPrincipalId)).toMatchObject({
      kind: "APPLIED", case: { state: "IN_PROGRESS", revision: 1 },
    });
    expect(await cases.advance({ ...transition, eventId: randomUUID() }, actorPrincipalId))
      .toMatchObject({ kind: "CONFLICT", code: "REVISION_CONFLICT" });

    const closed = {
      caseId, eventId: randomUUID(), expectedRevision: 1,
      nextState: "CLOSED" as const, note: "Acompanhei e confirmei manualmente este atendimento.",
      attested: true,
    };
    expect(await cases.advance(closed, actorPrincipalId)).toMatchObject({
      kind: "APPLIED", case: { state: "CLOSED", revision: 2 },
    });
    const events = await cases.timeline(caseId);
    expect(events).toHaveLength(3);
    const rows = await pool.query<{
      grants: string; paymentEvents: string; orders: string;
    }>(
      "SELECT (SELECT count(*)::text FROM entitlement_grants) AS grants, " +
      "(SELECT count(*)::text FROM premium_payment_events) AS \"paymentEvents\", " +
      "(SELECT count(*)::text FROM premium_orders) AS orders",
    );
    expect(rows.rows[0]).toEqual({ grants: "0", paymentEvents: "0", orders: "0" });
  });

  it("rejects a changed payload with the same delivery request ID instead of double granting", async () => {
    const requestId = randomUUID();
    const original = {
      requestId, playerId, sku: "2XP", quantity: 1,
      reason: "Primeira entrega autorizada externamente.",
    };
    expect(await service.deliver(original, actorPrincipalId)).toMatchObject({
      kind: "APPLIED", replayed: false,
    });
    expect(await service.deliver(
      { ...original, quantity: 2 }, actorPrincipalId,
    )).toEqual({ kind: "IDEMPOTENCY_CONFLICT" });
    const history = await service.history(playerId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ requestId, quantity: 1, durationSeconds: 604800 });
  });

  it("serializes simultaneous retries for one 2XP request into a single ledger grant", async () => {
    const requestId = randomUUID();
    const input = {
      requestId, playerId, sku: "2XP", quantity: 1,
      reason: "Entrega validada externamente com reenvios simultâneos.",
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => service.deliver(input, actorPrincipalId)),
    );
    expect(results.every((result) => result.kind === "APPLIED")).toBe(true);
    expect(results.filter((result) => result.kind === "APPLIED" && !result.replayed))
      .toHaveLength(1);
    expect(results.filter((result) => result.kind === "APPLIED" && result.replayed))
      .toHaveLength(5);
    const entries = await service.history(playerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ requestId, sku: "2XP", quantity: 1 });
    const grants = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM entitlement_grants WHERE player_id = $1 AND idempotency_key = $2",
      [playerId, requestId],
    );
    expect(grants.rows[0]?.count).toBe("1");
  });


  it("drives real Premium HTTP owner/delegate grants through disposable PostgreSQL, with a single audit trail", async () => {
    const access = { role: "owner" as "owner" | "delegate" | "ordinary-admin" | "player" };
    const identity = { provider: "baileys" as const, externalId: "5511999999999@s.whatsapp.net" };
    // Only Premium routes are called. All other handler dependencies are unused
    // test doubles, while premiumDelivery is the REAL PostgreSQL-backed service.
    const handler = new PlayerPortalHttpHandler({
      sessions: { verify: () => ok(identity) },
      admin: {
        resolvePrincipal: async () =>
          access.role === "player" ? null : { principalId: actorPrincipalId },
        capabilitiesFor: async () =>
          access.role === "owner" ? ["central.view"] :
          access.role === "delegate" ? ["central.view", "premium.delivery.grant", "player.read"] :
          ["central.view"],
      },
      adminTeam: { isOwner: async () => access.role === "owner" },
      premiumDelivery: service,
    } as unknown as ConstructorParameters<typeof PlayerPortalHttpHandler>[0]);

    const api = (path: string, method: "GET" | "POST" = "GET", body?: unknown) =>
      handler.handle(new Request(`https://synthetic-hub.invalid${path}`, {
        method,
        headers: {
          cookie: "__Host-pokemon_hub_session=test.session",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    const base = "/v1/hub/admin/premium/delivery";
    const historyPath = `/v1/hub/admin/premium/players/${playerId}/deliveries`;

    const catalog = await api(base + "/catalog");
    expect(catalog.status).toBe(200);
    const products = (await catalog.json()).products;
    expect(products).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: "2XP" }),
      expect.objectContaining({ sku: "LUCK" }),
    ]));

    const xp = {
      requestId: randomUUID(), playerId, sku: "2XP", quantity: 2,
      reason: "Duas semanas autorizadas após conferência externa.",
    };
    const first = await api(base, "POST", xp);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ applied: true, replayed: false });
    const replay = await api(base, "POST", xp);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ applied: true, replayed: true });
    const conflict = await api(base, "POST", { ...xp, quantity: 3 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "IDEMPOTENCY_CONFLICT" });

    access.role = "delegate";
    const luck = {
      requestId: randomUUID(), playerId, sku: "LUCK", quantity: 1,
      reason: "Sorte permanente autorizada por operador delegado.",
    };
    const delivered = await api(base, "POST", luck);
    expect(delivered.status).toBe(201);
    expect(await delivered.json()).toMatchObject({
      applied: true, entitlement: { entitlementKey: "CAPTURE_LUCK_2X", expiresAt: null },
    });

    const audit = await api(historyPath);
    expect(audit.status).toBe(200);
    expect((await audit.json()).deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: "2XP", requestId: xp.requestId, durationSeconds: 1209600 }),
      expect.objectContaining({ sku: "LUCK", requestId: luck.requestId, durationSeconds: null }),
    ]));

    access.role = "ordinary-admin";
    expect((await api(base, "POST", { ...luck, requestId: randomUUID() })).status).toBe(403);
    expect((await api(historyPath)).status).toBe(403);
    access.role = "player";
    expect((await api(base + "/catalog")).status).toBe(403);

    const counts = await pool.query<{
      grants: string; paymentEvents: string; orders: string;
    }>(
      "SELECT (SELECT count(*)::text FROM entitlement_grants) AS grants, " +
      "(SELECT count(*)::text FROM premium_payment_events) AS \\"paymentEvents\\", " +
      "(SELECT count(*)::text FROM premium_orders) AS orders",
    );
    expect(counts.rows[0]).toEqual({ grants: "2", paymentEvents: "0", orders: "0" });
    expect((await service.history(playerId))).toHaveLength(2);
  });

  it("refuses to issue an unpublished gamepass or quantity beyond backend limits", async () => {
    expect(await service.deliver({
      requestId: randomUUID(), playerId, sku: "TERA", quantity: 1,
      reason: "Atendimento manual em vez de executor não existente.",
    }, actorPrincipalId)).toEqual({ kind: "PRODUCT_UNAVAILABLE" });
    expect(await service.deliver({
      requestId: randomUUID(), playerId, sku: "LUCK", quantity: 2,
      reason: "Tentativa de exceder limite permitido pela loja.",
    }, actorPrincipalId)).toEqual({ kind: "QUANTITY_LIMIT" });
    expect((await service.history(playerId))).toHaveLength(0);
  });
});
