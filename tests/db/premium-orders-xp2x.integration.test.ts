import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EntitlementService } from "../../src/modules/entitlements/service.js";
import { PremiumEntitlementFulfillmentService } from "../../src/modules/premium-orders/entitlement-fulfillment-service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEntitlementRepository } from "../../src/platform/entitlements/postgres-entitlement-repository.js";
import { PostgresPremiumOrderRepository } from "../../src/platform/premium-orders/postgres-premium-order-repository.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("premium 2XP order fulfillment", () => {
  const dbName = `pokemon_premium_xp2x_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let orders: PostgresPremiumOrderRepository;
  let fulfillment: PremiumEntitlementFulfillmentService;
  let playerId: string;
  let now = new Date("2026-10-17T20:00:00.000Z");

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "premium-xp2x-vitest" });

    orders = new PostgresPremiumOrderRepository(pool, () => new Date(now));
    const entitlements = new EntitlementService(
      new PostgresEntitlementRepository(pool, () => new Date(now)),
    );
    fulfillment = new PremiumEntitlementFulfillmentService(orders, entitlements);
  }, 30_000);

  beforeEach(async () => {
    await pool.query("DELETE FROM premium_fulfillment_events");
    await pool.query("DELETE FROM premium_payment_events");
    await pool.query("DELETE FROM premium_order_items");
    await pool.query("DELETE FROM premium_orders");
    await pool.query("DELETE FROM entitlement_grants");
    await pool.query("DELETE FROM player_entitlements");
    await pool.query("DELETE FROM player_identities");
    await pool.query("DELETE FROM player_profiles");
    await pool.query("DELETE FROM onboarding_states");
    await pool.query("DELETE FROM trainer_progression");
    await pool.query("DELETE FROM players");

    now = new Date("2026-10-17T20:00:00.000Z");
    playerId = randomUUID();
    await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [playerId]);
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

  it("seeds the canonical 2XP product as BRL 40 with server max 52 and seven days per unit", async () => {
    const result = await pool.query<{
      sku: string;
      unit_price_cents: string;
      max_quantity: number;
      fulfillment_kind: string;
      fulfillment_payload: Record<string, unknown>;
    }>(
      `SELECT sku, unit_price_cents::text, max_quantity, fulfillment_kind, fulfillment_payload
       FROM premium_product_definitions WHERE sku = '2XP'`,
    );

    expect(result.rows[0]).toEqual({
      sku: "2XP",
      unit_price_cents: "4000",
      max_quantity: 52,
      fulfillment_kind: "ENTITLEMENT",
      fulfillment_payload: {
        entitlementKey: "XP_2X",
        grantModel: "TIMED",
        durationSecondsPerUnit: 604800,
      },
    });
  });

  it("enforces the canonical quantity limit on the server", async () => {
    const result = await orders.createOrder({
      playerId,
      items: [{ sku: "2XP", quantity: 53 }],
      idempotencyScope: "test",
      idempotencyKey: "too-many-2xp",
      metadata: {},
      correlationId: null,
    });

    expect(result).toEqual({ kind: "QUANTITY_LIMIT", sku: "2XP", maxQuantity: 52 });
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM premium_orders",
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("starts on fulfillment, grants quantity two as 14 days, and replay never extends twice", async () => {
    const created = await orders.createOrder({
      playerId,
      items: [{ sku: "2XP", quantity: 2 }],
      idempotencyScope: "test",
      idempotencyKey: "two-units",
      metadata: {},
      correlationId: null,
    });
    if (created.kind !== "CREATED") throw new Error(`order fixture failed: ${created.kind}`);
    expect(created.order.totalCents).toBe(8000);

    const paid = await orders.applyPaymentEvent({
      orderId: created.order.id,
      provider: "MANUAL_PIX",
      externalEventId: "two-units-paid",
      eventType: "PAID",
      amountCents: 8000,
      currency: "BRL",
      payloadDigest: null,
      correlationId: null,
    });
    if (paid.kind !== "APPLIED") throw new Error(`payment fixture failed: ${paid.kind}`);

    const item = paid.order.items[0];
    if (item === undefined) throw new Error("missing order item");
    const first = await fulfillment.fulfillOrderItem({
      orderId: paid.order.id,
      orderItemId: item.id,
      correlationId: null,
    });
    expect(first).toMatchObject({
      kind: "APPLIED",
      replayed: false,
      fulfillment: { kind: "APPLIED", order: { status: "APPLIED" } },
    });

    const state = await pool.query<{
      starts_at: Date;
      expires_at: Date;
      revision: string;
    }>(
      `SELECT starts_at, expires_at, revision::text
       FROM player_entitlements
       WHERE player_id = $1 AND entitlement_key = 'XP_2X'`,
      [playerId],
    );
    expect(state.rows[0]?.starts_at.toISOString()).toBe("2026-10-17T20:00:00.000Z");
    expect(state.rows[0]?.expires_at.toISOString()).toBe("2026-10-31T20:00:00.000Z");
    expect(state.rows[0]?.revision).toBe("0");

    now = new Date("2026-10-18T20:00:00.000Z");
    const replay = await fulfillment.fulfillOrderItem({
      orderId: paid.order.id,
      orderItemId: item.id,
      correlationId: null,
    });
    expect(replay).toMatchObject({ kind: "APPLIED", replayed: true });

    const afterReplay = await pool.query<{ expires_at: Date; grants: string }>(
      `SELECT state.expires_at,
              (SELECT count(*)::text FROM entitlement_grants grants
               WHERE grants.player_id = state.player_id AND grants.entitlement_key = state.entitlement_key) AS grants
       FROM player_entitlements state
       WHERE state.player_id = $1 AND state.entitlement_key = 'XP_2X'`,
      [playerId],
    );
    expect(afterReplay.rows[0]?.expires_at.toISOString()).toBe("2026-10-31T20:00:00.000Z");
    expect(afterReplay.rows[0]?.grants).toBe("1");
  });

  it("a later purchase extends the future expiry instead of creating a 4x stack", async () => {
    const createPaidFulfilled = async (key: string) => {
      const created = await orders.createOrder({
        playerId,
        items: [{ sku: "2XP", quantity: 1 }],
        idempotencyScope: "test",
        idempotencyKey: `order-${key}`,
        metadata: {},
        correlationId: null,
      });
      if (created.kind !== "CREATED") throw new Error(`order fixture failed: ${created.kind}`);
      const paid = await orders.applyPaymentEvent({
        orderId: created.order.id,
        provider: "MANUAL_PIX",
        externalEventId: `paid-${key}`,
        eventType: "PAID",
        amountCents: 4000,
        currency: "BRL",
        payloadDigest: null,
        correlationId: null,
      });
      if (paid.kind !== "APPLIED") throw new Error(`payment fixture failed: ${paid.kind}`);
      const item = paid.order.items[0];
      if (item === undefined) throw new Error("missing order item");
      const applied = await fulfillment.fulfillOrderItem({
        orderId: paid.order.id,
        orderItemId: item.id,
        correlationId: null,
      });
      if (applied.kind !== "APPLIED") throw new Error(`fulfillment failed: ${applied.kind}`);
    };

    await createPaidFulfilled("first");
    now = new Date("2026-10-20T20:00:00.000Z");
    await createPaidFulfilled("second");

    const state = await pool.query<{
      starts_at: Date;
      expires_at: Date;
      revision: string;
      grants: string;
    }>(
      `SELECT state.starts_at, state.expires_at, state.revision::text,
              (SELECT count(*)::text FROM entitlement_grants grants
               WHERE grants.player_id = state.player_id AND grants.entitlement_key = state.entitlement_key) AS grants
       FROM player_entitlements state
       WHERE state.player_id = $1 AND state.entitlement_key = 'XP_2X'`,
      [playerId],
    );

    expect(state.rows[0]?.starts_at.toISOString()).toBe("2026-10-17T20:00:00.000Z");
    expect(state.rows[0]?.expires_at.toISOString()).toBe("2026-10-31T20:00:00.000Z");
    expect(state.rows[0]?.revision).toBe("1");
    expect(state.rows[0]?.grants).toBe("2");
  });
});
