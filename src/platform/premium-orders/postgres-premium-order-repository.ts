import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CreatePremiumOrderInput,
  CreatePremiumOrderResult,
  PremiumFulfillmentKind,
  PremiumFulfillmentResult,
  PremiumOrderItemView,
  PremiumOrderStatus,
  PremiumOrderView,
  PremiumPaymentEventInput,
  PremiumPaymentEventResult,
  RecordPremiumFulfillmentInput,
} from "../../modules/premium-orders/contracts.js";
import type { PremiumOrderRepository } from "../../modules/premium-orders/ports.js";
import { withTransaction } from "../db/transaction.js";

interface ProductRow {
  sku: string;
  title: string;
  currency: string;
  unit_price_cents: string;
  max_quantity: number;
  active: boolean;
  fulfillment_kind: PremiumFulfillmentKind;
  fulfillment_payload: Record<string, unknown>;
}

interface OrderRow {
  id: string;
  human_id: string;
  player_id: string;
  status: PremiumOrderStatus;
  currency: string;
  total_cents: string;
  revision: string;
  created_at: Date;
  paid_at: Date | null;
  applied_at: Date | null;
  cancelled_at: Date | null;
}

interface OrderItemRow {
  id: string;
  line_no: number;
  product_sku: string;
  product_title_snapshot: string;
  unit_price_cents: string;
  quantity: number;
  line_total_cents: string;
  fulfillment_kind_snapshot: PremiumFulfillmentKind;
  fulfillment_payload_snapshot: Record<string, unknown>;
  fulfilled: boolean;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

function safeNumber(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds the JavaScript safe integer range`);
  }
  return parsed;
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

function createOrderFingerprint(input: CreatePremiumOrderInput): string {
  return fingerprint({
    playerId: input.playerId,
    items: input.items,
    metadata: input.metadata,
  });
}

function paymentFingerprint(input: PremiumPaymentEventInput): string {
  return fingerprint({
    orderId: input.orderId,
    provider: input.provider,
    externalEventId: input.externalEventId,
    eventType: input.eventType,
    amountCents: input.amountCents,
    currency: input.currency,
    payloadDigest: input.payloadDigest,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
  });
}

function fulfillmentFingerprint(input: RecordPremiumFulfillmentInput): string {
  return fingerprint({
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    result: input.result,
  });
}

function itemView(row: OrderItemRow): PremiumOrderItemView {
  return {
    id: row.id,
    lineNo: row.line_no,
    sku: row.product_sku,
    title: row.product_title_snapshot,
    unitPriceCents: safeNumber(row.unit_price_cents, "Premium order unit price"),
    quantity: row.quantity,
    lineTotalCents: safeNumber(row.line_total_cents, "Premium order line total"),
    fulfillmentKind: row.fulfillment_kind_snapshot,
    fulfillmentPayload: row.fulfillment_payload_snapshot,
    fulfilled: row.fulfilled,
  };
}

async function loadOrder(client: PoolClient, orderId: string): Promise<PremiumOrderView | null> {
  const header = await client.query<OrderRow>(
    `SELECT id, human_id, player_id, status, currency, total_cents::text, revision::text,
            created_at, paid_at, applied_at, cancelled_at
     FROM premium_orders
     WHERE id = $1`,
    [orderId],
  );
  const row = header.rows[0];
  if (row === undefined) return null;

  const items = await client.query<OrderItemRow>(
    `SELECT item.id, item.line_no, item.product_sku, item.product_title_snapshot,
            item.unit_price_cents::text, item.quantity, item.line_total_cents::text,
            item.fulfillment_kind_snapshot, item.fulfillment_payload_snapshot,
            EXISTS (
              SELECT 1 FROM premium_fulfillment_events fulfillment
              WHERE fulfillment.order_item_id = item.id
            ) AS fulfilled
     FROM premium_order_items item
     WHERE item.order_id = $1
     ORDER BY item.line_no`,
    [orderId],
  );

  return {
    id: row.id,
    humanId: row.human_id,
    playerId: row.player_id,
    status: row.status,
    currency: row.currency,
    totalCents: safeNumber(row.total_cents, "Premium order total"),
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    paidAt: row.paid_at?.toISOString() ?? null,
    appliedAt: row.applied_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    items: items.rows.map(itemView),
  };
}

export class PostgresPremiumOrderRepository implements PremiumOrderRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async createOrder(input: CreatePremiumOrderInput): Promise<CreatePremiumOrderResult> {
    const requestFingerprint = createOrderFingerprint(input);
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `premium-order-create:${input.idempotencyScope}:${input.idempotencyKey}`,
      ]);

      const replay = await client.query<{
        id: string;
        request_fingerprint: string;
      }>(
        `SELECT id, request_fingerprint
         FROM premium_orders
         WHERE idempotency_scope = $1 AND idempotency_key = $2`,
        [input.idempotencyScope, input.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        if (replayRow.request_fingerprint !== requestFingerprint) {
          return { kind: "IDEMPOTENCY_CONFLICT" };
        }
        const order = await loadOrder(client, replayRow.id);
        if (order === null) {
          throw new Error("Premium order disappeared during idempotent replay");
        }
        return { kind: "CREATED", replayed: true, order };
      }

      const player = await client.query(
        `SELECT 1 FROM players WHERE id = $1 AND status = 'ACTIVE'`,
        [input.playerId],
      );
      if (player.rowCount !== 1) return { kind: "PLAYER_NOT_FOUND" };

      const requestedSkus = input.items.map((item) => item.sku);
      const products = await client.query<ProductRow>(
        `SELECT sku, title, currency, unit_price_cents::text, max_quantity, active,
                fulfillment_kind, fulfillment_payload
         FROM premium_product_definitions
         WHERE sku = ANY($1::text[])`,
        [requestedSkus],
      );
      const productBySku = new Map(products.rows.map((row) => [row.sku, row] as const));

      for (const item of input.items) {
        const product = productBySku.get(item.sku);
        if (product === undefined) return { kind: "PRODUCT_NOT_FOUND", sku: item.sku };
        if (!product.active) return { kind: "PRODUCT_INACTIVE", sku: item.sku };
        if (item.quantity > product.max_quantity) {
          return {
            kind: "QUANTITY_LIMIT",
            sku: item.sku,
            maxQuantity: product.max_quantity,
          };
        }
      }

      const currencies = new Set(input.items.map((item) => productBySku.get(item.sku)?.currency));
      if (currencies.size !== 1 || currencies.has(undefined)) return { kind: "MIXED_CURRENCY" };
      const currency = [...currencies][0];
      if (currency === undefined) throw new Error("Premium order currency resolution failed");

      let totalCents = 0;
      const snapshot = input.items.map((item, index) => {
        const product = productBySku.get(item.sku);
        if (product === undefined) {
          throw new Error("Premium product disappeared during snapshot");
        }
        const unitPriceCents = safeNumber(product.unit_price_cents, "Premium product price");
        const lineTotalCents = unitPriceCents * item.quantity;
        if (!Number.isSafeInteger(lineTotalCents)) {
          throw new Error("Premium order line total exceeds safe range");
        }
        totalCents += lineTotalCents;
        if (!Number.isSafeInteger(totalCents)) {
          throw new Error("Premium order total exceeds safe range");
        }
        return { item, product, lineNo: index + 1, unitPriceCents, lineTotalCents };
      });

      const sequence = await client.query<{ value: string }>(
        `SELECT nextval('premium_order_human_seq')::text AS value`,
      );
      const sequenceValue = sequence.rows[0]?.value;
      if (sequenceValue === undefined) {
        throw new Error("Premium order sequence did not return a value");
      }
      const humanId = `PB-${sequenceValue.padStart(8, "0")}`;
      const orderId = randomUUID();
      const createdAt = this.now();

      await client.query(
        `INSERT INTO premium_orders(
           id, human_id, player_id, status, currency, total_cents,
           idempotency_scope, idempotency_key, request_fingerprint,
           metadata, correlation_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $11)`,
        [
          orderId,
          humanId,
          input.playerId,
          currency,
          totalCents,
          input.idempotencyScope,
          input.idempotencyKey,
          requestFingerprint,
          JSON.stringify(input.metadata),
          input.correlationId,
          createdAt,
        ],
      );

      for (const line of snapshot) {
        await client.query(
          `INSERT INTO premium_order_items(
             id, order_id, line_no, product_sku, product_title_snapshot,
             unit_price_cents, quantity, line_total_cents,
             fulfillment_kind_snapshot, fulfillment_payload_snapshot
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            randomUUID(),
            orderId,
            line.lineNo,
            line.product.sku,
            line.product.title,
            line.unitPriceCents,
            line.item.quantity,
            line.lineTotalCents,
            line.product.fulfillment_kind,
            JSON.stringify(line.product.fulfillment_payload),
          ],
        );
      }

      const order = await loadOrder(client, orderId);
      if (order === null) throw new Error("Premium order was not readable after creation");
      return { kind: "CREATED", replayed: false, order };
    });
  }

  public async applyPaymentEvent(
    input: PremiumPaymentEventInput,
  ): Promise<PremiumPaymentEventResult> {
    const requestFingerprint = paymentFingerprint(input);
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `premium-payment:${input.provider}:${input.externalEventId}`,
        `premium-order:${input.orderId}`,
      ]);

      const replay = await client.query<{
        order_id: string;
        request_fingerprint: string;
      }>(
        `SELECT order_id, request_fingerprint
         FROM premium_payment_events
         WHERE provider = $1 AND external_event_id = $2`,
        [input.provider, input.externalEventId],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        if (replayRow.request_fingerprint !== requestFingerprint) {
          return { kind: "IDEMPOTENCY_CONFLICT" };
        }
        const order = await loadOrder(client, replayRow.order_id);
        if (order === null) {
          throw new Error("Premium order disappeared during payment replay");
        }
        return { kind: "APPLIED", replayed: true, order };
      }

      const locked = await client.query<OrderRow>(
        `SELECT id, human_id, player_id, status, currency, total_cents::text, revision::text,
                created_at, paid_at, applied_at, cancelled_at
         FROM premium_orders WHERE id = $1 FOR UPDATE`,
        [input.orderId],
      );
      const orderRow = locked.rows[0];
      if (orderRow === undefined) return { kind: "ORDER_NOT_FOUND" };

      if (
        orderRow.currency !== input.currency ||
        safeNumber(orderRow.total_cents, "Premium order total") !== input.amountCents
      ) {
        return { kind: "PAYMENT_MISMATCH" };
      }

      // Owner approvals are one-time, revision-checked decisions. The exact
      // same request replays above; a new request cannot silently re-pay.
      if (
        input.provider.startsWith("MANUAL_ADMIN:") &&
        (input.eventType !== "PAID" ||
          input.expectedRevision === undefined ||
          orderRow.status !== "PENDING" ||
          orderRow.revision !== input.expectedRevision)
      ) {
        return { kind: "STATE_CONFLICT", status: orderRow.status };
      }

      const now = this.now();
      if (input.eventType === "PAID") {
        if (orderRow.status === "CANCELLED") {
          return { kind: "STATE_CONFLICT", status: orderRow.status };
        }
        if (orderRow.status === "PENDING") {
          await client.query(
            `UPDATE premium_orders
             SET status = 'PAID', paid_at = $2, updated_at = $2, revision = revision + 1
             WHERE id = $1`,
            [input.orderId, now],
          );
        }
      } else {
        if (orderRow.status === "APPLIED") {
          return { kind: "STATE_CONFLICT", status: orderRow.status };
        }
        if (orderRow.status !== "CANCELLED") {
          await client.query(
            `UPDATE premium_orders
             SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2, revision = revision + 1
             WHERE id = $1`,
            [input.orderId, now],
          );
        }
      }

      await client.query(
        `INSERT INTO premium_payment_events(
           id, order_id, provider, external_event_id, event_type,
           amount_cents, currency, request_fingerprint, payload_digest,
           correlation_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(),
          input.orderId,
          input.provider,
          input.externalEventId,
          input.eventType,
          input.amountCents,
          input.currency,
          requestFingerprint,
          input.payloadDigest,
          input.correlationId,
          now,
        ],
      );

      const order = await loadOrder(client, input.orderId);
      if (order === null) throw new Error("Premium order disappeared after payment event");
      return { kind: "APPLIED", replayed: false, order };
    });
  }

  public async recordFulfillment(
    input: RecordPremiumFulfillmentInput,
  ): Promise<PremiumFulfillmentResult> {
    const requestFingerprint = fulfillmentFingerprint(input);
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `premium-fulfillment:${input.fulfillmentKey}`,
        `premium-order:${input.orderId}`,
        `premium-order-item:${input.orderItemId}`,
      ]);

      const replay = await client.query<{
        order_id: string;
        request_fingerprint: string;
      }>(
        `SELECT order_id, request_fingerprint
         FROM premium_fulfillment_events
         WHERE fulfillment_key = $1`,
        [input.fulfillmentKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        if (replayRow.request_fingerprint !== requestFingerprint) {
          return { kind: "IDEMPOTENCY_CONFLICT" };
        }
        const order = await loadOrder(client, replayRow.order_id);
        if (order === null) {
          throw new Error("Premium order disappeared during fulfillment replay");
        }
        return { kind: "APPLIED", replayed: true, order };
      }

      const orderState = await client.query<{ status: PremiumOrderStatus }>(
        `SELECT status FROM premium_orders WHERE id = $1 FOR UPDATE`,
        [input.orderId],
      );
      const status = orderState.rows[0]?.status;
      if (status === undefined) return { kind: "ORDER_NOT_FOUND" };
      if (status !== "PAID") return { kind: "ORDER_NOT_PAID", status };

      const item = await client.query<{ id: string }>(
        `SELECT id FROM premium_order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
        [input.orderItemId, input.orderId],
      );
      if (item.rowCount !== 1) return { kind: "ITEM_NOT_FOUND" };

      const existingForItem = await client.query(
        `SELECT 1 FROM premium_fulfillment_events WHERE order_item_id = $1`,
        [input.orderItemId],
      );
      if (existingForItem.rowCount === 1) return { kind: "ITEM_ALREADY_FULFILLED" };

      const now = this.now();
      await client.query(
        `INSERT INTO premium_fulfillment_events(
           id, order_id, order_item_id, fulfillment_key, request_fingerprint,
           result, correlation_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          randomUUID(),
          input.orderId,
          input.orderItemId,
          input.fulfillmentKey,
          requestFingerprint,
          JSON.stringify(input.result),
          input.correlationId,
          now,
        ],
      );

      const counts = await client.query<{ total: string; fulfilled: string }>(
        `SELECT
           (SELECT count(*)::text FROM premium_order_items WHERE order_id = $1) AS total,
           (SELECT count(*)::text FROM premium_fulfillment_events WHERE order_id = $1) AS fulfilled`,
        [input.orderId],
      );
      const countRow = counts.rows[0];
      if (countRow === undefined) {
        throw new Error("Premium fulfillment count query returned no row");
      }
      if (countRow.total === countRow.fulfilled) {
        await client.query(
          `UPDATE premium_orders
           SET status = 'APPLIED', applied_at = $2, updated_at = $2, revision = revision + 1
           WHERE id = $1 AND status = 'PAID'`,
          [input.orderId, now],
        );
      }

      const order = await loadOrder(client, input.orderId);
      if (order === null) throw new Error("Premium order disappeared after fulfillment");
      return { kind: "APPLIED", replayed: false, order };
    });
  }

  public async getOrder(orderId: string): Promise<PremiumOrderView | null> {
    const client = await this.pool.connect();
    try {
      return await loadOrder(client, orderId);
    } finally {
      client.release();
    }
  }

  public async listPlayerOrders(playerId: string): Promise<readonly PremiumOrderView[]> {
    const ids = await this.pool.query<{ id: string }>(
      `SELECT id FROM premium_orders WHERE player_id = $1 ORDER BY created_at DESC, id DESC`,
      [playerId],
    );
    const result: PremiumOrderView[] = [];
    const client = await this.pool.connect();
    try {
      for (const row of ids.rows) {
        const order = await loadOrder(client, row.id);
        if (order !== null) result.push(order);
      }
    } finally {
      client.release();
    }
    return result;
  }
}
