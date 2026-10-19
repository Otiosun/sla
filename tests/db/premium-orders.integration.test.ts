import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CreatePremiumOrderInput } from "../../src/modules/premium-orders/contracts.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPremiumOrderRepository } from "../../src/platform/premium-orders/postgres-premium-order-repository.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function createInput(
  playerId: string,
  overrides: Partial<CreatePremiumOrderInput> = {},
): CreatePremiumOrderInput {
  return {
    playerId,
    items: [{ sku: "XP_2X_7D", quantity: 1 }],
    idempotencyScope: "hub-premium-order",
    idempotencyKey: `order:${randomUUID()}`,
    metadata: { channel: "HUB" },
    correlationId: null,
    ...overrides,
  };
}

describe.sequential("PostgresPremiumOrderRepository", () => {
  const dbName = `pokemon_premium_orders_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresPremiumOrderRepository;
  let playerId: string;
  let now = new Date("2026-10-17T18:00:00.000Z");

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "premium-orders-vitest" });
    repository = new PostgresPremiumOrderRepository(pool, () => new Date(now));
  }, 30_000);

  beforeEach(async () => {
    await pool.query("DELETE FROM premium_fulfillment_events");
    await pool.query("DELETE FROM premium_payment_events");
    await pool.query("DELETE FROM premium_order_items");
    await pool.query("DELETE FROM premium_orders");
    await pool.query("DELETE FROM premium_product_definitions");
    await pool.query("DELETE FROM player_identities");
    await pool.query("DELETE FROM player_profiles");
    await pool.query("DELETE FROM onboarding_states");
    await pool.query("DELETE FROM trainer_progression");
    await pool.query("DELETE FROM players");

    now = new Date("2026-10-17T18:00:00.000Z");
    playerId = randomUUID();
    await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [playerId]);
    await pool.query(
      `INSERT INTO premium_product_definitions(
         sku, title, currency, unit_price_cents, active, fulfillment_kind, fulfillment_payload
       ) VALUES
       ('XP_2X_7D', '2× XP · 7 dias', 'BRL', 2900, TRUE, 'ENTITLEMENT',
        '{"entitlementKey":"XP_2X","grantModel":"TIMED","durationSeconds":604800}'::jsonb),
       ('POKE_PACK_A', 'Pacote Pokémon A', 'BRL', 4900, TRUE, 'POKEMON_PACKAGE',
        '{"packageKey":"PACK_A"}'::jsonb),
       ('INACTIVE_SKU', 'Desativado', 'BRL', 1000, FALSE, 'MANUAL', '{}'::jsonb),
       ('USD_SKU', 'Outro câmbio', 'USD', 500, TRUE, 'MANUAL', '{}'::jsonb)`,
    );
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

  it("creates a server-priced order with human and technical IDs plus immutable snapshots", async () => {
    const result = await repository.createOrder(
      createInput(playerId, {
        items: [
          { sku: "XP_2X_7D", quantity: 2 },
          { sku: "POKE_PACK_A", quantity: 1 },
        ],
        idempotencyKey: "snapshot-order",
      }),
    );

    expect(result.kind).toBe("CREATED");
    if (result.kind !== "CREATED") return;
    expect(result.replayed).toBe(false);
    expect(result.order.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.order.humanId).toMatch(/^PB-\d{8,20}$/);
    expect(result.order).toMatchObject({
      playerId,
      status: "PENDING",
      currency: "BRL",
      totalCents: 10700,
      revision: "0",
      paidAt: null,
      appliedAt: null,
      cancelledAt: null,
    });
    expect(result.order.items).toEqual([
      expect.objectContaining({
        lineNo: 1,
        sku: "XP_2X_7D",
        title: "2× XP · 7 dias",
        unitPriceCents: 2900,
        quantity: 2,
        lineTotalCents: 5800,
        fulfillmentKind: "ENTITLEMENT",
        fulfilled: false,
      }),
      expect.objectContaining({
        lineNo: 2,
        sku: "POKE_PACK_A",
        unitPriceCents: 4900,
        quantity: 1,
        lineTotalCents: 4900,
        fulfillmentKind: "POKEMON_PACKAGE",
        fulfilled: false,
      }),
    ]);
  });

  it("replays an identical create request and rejects semantic reuse of its idempotency key", async () => {
    const input = createInput(playerId, { idempotencyKey: "same-create" });
    const first = await repository.createOrder(input);
    const replay = await repository.createOrder(input);
    const conflict = await repository.createOrder({
      ...input,
      items: [{ sku: "XP_2X_7D", quantity: 2 }],
    });

    expect(first).toMatchObject({ kind: "CREATED", replayed: false });
    expect(replay).toMatchObject({ kind: "CREATED", replayed: true });
    expect(conflict).toEqual({ kind: "IDEMPOTENCY_CONFLICT" });

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM premium_orders",
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("refuses missing or inactive products and mixed currencies without creating an order", async () => {
    await expect(
      repository.createOrder(
        createInput(playerId, {
          items: [{ sku: "MISSING_SKU", quantity: 1 }],
          idempotencyKey: "missing-product",
        }),
      ),
    ).resolves.toEqual({ kind: "PRODUCT_NOT_FOUND", sku: "MISSING_SKU" });

    await expect(
      repository.createOrder(
        createInput(playerId, {
          items: [{ sku: "INACTIVE_SKU", quantity: 1 }],
          idempotencyKey: "inactive-product",
        }),
      ),
    ).resolves.toEqual({ kind: "PRODUCT_INACTIVE", sku: "INACTIVE_SKU" });

    await expect(
      repository.createOrder(
        createInput(playerId, {
          items: [
            { sku: "XP_2X_7D", quantity: 1 },
            { sku: "USD_SKU", quantity: 1 },
          ],
          idempotencyKey: "mixed-currency",
        }),
      ),
    ).resolves.toEqual({ kind: "MIXED_CURRENCY" });

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM premium_orders",
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("applies a webhook-compatible paid event exactly once and rejects event-ID drift", async () => {
    const created = await repository.createOrder(
      createInput(playerId, { idempotencyKey: "pay-order" }),
    );
    if (created.kind !== "CREATED") throw new Error("Order fixture failed");
    const event = {
      orderId: created.order.id,
      provider: "MANUAL_PIX",
      externalEventId: "pix-event-001",
      eventType: "PAID" as const,
      amountCents: 2900,
      currency: "BRL",
      payloadDigest: "a".repeat(64),
      correlationId: null,
    };

    const paid = await repository.applyPaymentEvent(event);
    expect(paid).toMatchObject({
      kind: "APPLIED",
      replayed: false,
      order: { status: "PAID", revision: "1", paidAt: "2026-10-17T18:00:00.000Z" },
    });

    now = new Date("2026-10-17T18:05:00.000Z");
    const replay = await repository.applyPaymentEvent(event);
    expect(replay).toMatchObject({ kind: "APPLIED", replayed: true, order: { status: "PAID" } });

    const conflict = await repository.applyPaymentEvent({ ...event, amountCents: 5800 });
    expect(conflict).toEqual({ kind: "IDEMPOTENCY_CONFLICT" });

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM premium_payment_events",
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("keeps payment mismatch pending and supports cancellation before fulfillment", async () => {
    const created = await repository.createOrder(
      createInput(playerId, { idempotencyKey: "cancel-order" }),
    );
    if (created.kind !== "CREATED") throw new Error("Order fixture failed");

    const mismatch = await repository.applyPaymentEvent({
      orderId: created.order.id,
      provider: "MANUAL_PIX",
      externalEventId: "wrong-amount",
      eventType: "PAID",
      amountCents: 1,
      currency: "BRL",
      payloadDigest: null,
      correlationId: null,
    });
    expect(mismatch).toEqual({ kind: "PAYMENT_MISMATCH" });

    const cancelled = await repository.applyPaymentEvent({
      orderId: created.order.id,
      provider: "MANUAL_PIX",
      externalEventId: "cancel-event",
      eventType: "CANCELLED",
      amountCents: 2900,
      currency: "BRL",
      payloadDigest: null,
      correlationId: null,
    });
    expect(cancelled).toMatchObject({ kind: "APPLIED", order: { status: "CANCELLED" } });

    const latePaid = await repository.applyPaymentEvent({
      orderId: created.order.id,
      provider: "MANUAL_PIX",
      externalEventId: "late-paid",
      eventType: "PAID",
      amountCents: 2900,
      currency: "BRL",
      payloadDigest: null,
      correlationId: null,
    });
    expect(latePaid).toEqual({ kind: "STATE_CONFLICT", status: "CANCELLED" });
  });

  it("marks an order APPLIED only after every line has one durable fulfillment record", async () => {
    const created = await repository.createOrder(
      createInput(playerId, {
        items: [
          { sku: "XP_2X_7D", quantity: 1 },
          { sku: "POKE_PACK_A", quantity: 1 },
        ],
        idempotencyKey: "fulfill-order",
      }),
    );
    if (created.kind !== "CREATED") throw new Error("Order fixture failed");

    const paid = await repository.applyPaymentEvent({
      orderId: created.order.id,
      provider: "MANUAL_PIX",
      externalEventId: "fulfill-paid",
      eventType: "PAID",
      amountCents: 7800,
      currency: "BRL",
      payloadDigest: null,
      correlationId: null,
    });
    if (paid.kind !== "APPLIED") throw new Error("Payment fixture failed");

    const firstItem = paid.order.items[0];
    const secondItem = paid.order.items[1];
    if (firstItem === undefined || secondItem === undefined)
      throw new Error("Order item fixture failed");

    const first = await repository.recordFulfillment({
      orderId: paid.order.id,
      orderItemId: firstItem.id,
      fulfillmentKey: `premium-item:${firstItem.id}`,
      result: { grantId: "grant-xp" },
      correlationId: null,
    });
    expect(first).toMatchObject({
      kind: "APPLIED",
      replayed: false,
      order: { status: "PAID", revision: "1" },
    });
    if (first.kind === "APPLIED") {
      expect(first.order.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: firstItem.id,
            fulfilled: true,
          }),
          expect.objectContaining({
            id: secondItem.id,
            fulfilled: false,
          }),
        ]),
      );
    }

    const second = await repository.recordFulfillment({
      orderId: paid.order.id,
      orderItemId: secondItem.id,
      fulfillmentKey: `premium-item:${secondItem.id}`,
      result: { packageGrantId: "pack-a" },
      correlationId: null,
    });
    expect(second).toMatchObject({
      kind: "APPLIED",
      replayed: false,
      order: { status: "APPLIED", revision: "2", appliedAt: "2026-10-17T18:00:00.000Z" },
    });
    if (second.kind === "APPLIED") {
      expect(second.order.items.every((item) => item.fulfilled)).toBe(true);
    }

    const replay = await repository.recordFulfillment({
      orderId: paid.order.id,
      orderItemId: secondItem.id,
      fulfillmentKey: `premium-item:${secondItem.id}`,
      result: { packageGrantId: "pack-a" },
      correlationId: null,
    });
    expect(replay).toMatchObject({ kind: "APPLIED", replayed: true, order: { status: "APPLIED" } });

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM premium_fulfillment_events WHERE order_id = $1",
      [paid.order.id],
    );
    expect(count.rows[0]?.count).toBe("2");
  });

  it("blocks fulfillment while the order is unpaid", async () => {
    const created = await repository.createOrder(
      createInput(playerId, { idempotencyKey: "unpaid-order" }),
    );
    if (created.kind !== "CREATED") throw new Error("Order fixture failed");
    const item = created.order.items[0];
    if (item === undefined) throw new Error("Order item fixture failed");

    const result = await repository.recordFulfillment({
      orderId: created.order.id,
      orderItemId: item.id,
      fulfillmentKey: `premium-item:${item.id}`,
      result: {},
      correlationId: null,
    });
    expect(result).toEqual({ kind: "ORDER_NOT_PAID", status: "PENDING" });
  });

  it("serializes simultaneous duplicate order creation into one order plus one replay", async () => {
    const input = createInput(playerId, { idempotencyKey: "concurrent-create" });
    const [left, right] = await Promise.all([
      repository.createOrder(input),
      repository.createOrder(input),
    ]);
    const created = [left, right].filter((result) => result.kind === "CREATED");
    expect(created).toHaveLength(2);
    expect(
      created.map((result) => (result.kind === "CREATED" ? result.replayed : null)).sort(),
    ).toEqual([false, true]);

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM premium_orders",
    );
    expect(count.rows[0]?.count).toBe("1");
  });
});
