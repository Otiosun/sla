import type { Pool } from "pg";
import { z } from "zod";
import type { EntitlementService } from "../entitlements/service.js";

export const ManualPremiumDeliverySchema = z
  .object({
    requestId: z.string().uuid(),
    playerId: z.string().uuid(),
    sku: z.string().regex(/^[A-Z0-9][A-Z0-9_.:-]{1,127}$/),
    quantity: z.number().int().min(1).max(99),
    reason: z.string().trim().min(8).max(400),
  })
  .strict();

interface CatalogRow {
  sku: string;
  title: string;
  max_quantity: number;
  entitlement_key: string;
  grant_model: "PERMANENT" | "TIMED";
  duration_seconds_per_unit: number | null;
}
interface HistoryRow {
  id: string;
  entitlement_key: string;
  duration_seconds: string | null;
  actor_id: string;
  idempotency_key: string;
  metadata: { sku?: string; quantity?: number; reason?: string };
  created_at: Date;
}

const MAX_DURATION_SECONDS = 10 * 365 * 24 * 60 * 60;

/** No payment mutation: an owner or explicitly delegated admin grants a published entitlement. */
export class ManualPremiumDeliveryService {
  public constructor(
    private readonly pool: Pool,
    private readonly entitlements: Pick<EntitlementService, "grant">,
  ) {}

  public async catalog(): Promise<readonly {
    sku: string;
    title: string;
    maxQuantity: number;
    entitlementKey: string;
    grantModel: "PERMANENT" | "TIMED";
    durationSecondsPerUnit: number | null;
  }[]> {
    const rows = await this.pool.query<CatalogRow>(
      `SELECT sku, title, max_quantity,
              fulfillment_payload->>'entitlementKey' AS entitlement_key,
              fulfillment_payload->>'grantModel' AS grant_model,
              CASE WHEN fulfillment_payload->>'grantModel' = 'TIMED'
              THEN (fulfillment_payload->>'durationSecondsPerUnit')::integer ELSE NULL END
                AS duration_seconds_per_unit
       FROM premium_product_definitions
       WHERE active = TRUE AND fulfillment_kind = 'ENTITLEMENT'
         AND fulfillment_payload->>'grantModel' IN ('TIMED', 'PERMANENT')
         AND (fulfillment_payload->>'grantModel' = 'PERMANENT'
           OR (fulfillment_payload->>'durationSecondsPerUnit') ~ '^[0-9]{1,9}$')
       ORDER BY sku`,
    );
    return rows.rows
      .filter((row) =>
        row.entitlement_key && /^[A-Z0-9][A-Z0-9_.:-]{1,127}$/.test(row.entitlement_key) &&
        row.max_quantity >= 1 && row.max_quantity <= 99 &&
        (row.grant_model === "PERMANENT" ||
          (Number.isSafeInteger(row.duration_seconds_per_unit) &&
            (row.duration_seconds_per_unit ?? 0) > 0 &&
            (row.duration_seconds_per_unit ?? 0) <= MAX_DURATION_SECONDS)),
      )
      .map((row) => ({
        sku: row.sku,
        title: row.title,
        maxQuantity: row.grant_model === "PERMANENT" ? 1 : row.max_quantity,
        entitlementKey: row.entitlement_key,
        grantModel: row.grant_model,
        durationSecondsPerUnit: row.duration_seconds_per_unit,
      }));
  }

  public async history(playerId: string): Promise<readonly {
    id: string;
    entitlementKey: string;
    durationSeconds: number | null;
    actorPrincipalId: string;
    requestId: string;
    sku: string;
    quantity: number;
    reason: string;
    createdAt: string;
  }[]> {
    const rows = await this.pool.query<HistoryRow>(
      `SELECT id, entitlement_key, duration_seconds::text, actor_id,
              idempotency_key, metadata, created_at
       FROM entitlement_grants
       WHERE player_id = $1 AND source_type = 'ADMIN_DELIVERY' AND actor_type = 'ADMIN'
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      [playerId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      entitlementKey: row.entitlement_key,
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      actorPrincipalId: row.actor_id,
      requestId: row.idempotency_key,
      sku: row.metadata.sku ?? "",
      quantity: row.metadata.quantity ?? 0,
      reason: row.metadata.reason ?? "",
      createdAt: row.created_at.toISOString(),
    }));
  }

  public async deliver(raw: unknown, actorPrincipalId: string) {
    const input = ManualPremiumDeliverySchema.parse(raw);
    const catalog = await this.catalog();
    const item = catalog.find((candidate) => candidate.sku === input.sku);
    if (!item) return { kind: "PRODUCT_UNAVAILABLE" } as const;
    if (input.quantity > item.maxQuantity) return { kind: "QUANTITY_LIMIT" } as const;

    const durationSeconds = item.grantModel === "TIMED"
      ? (item.durationSecondsPerUnit ?? 0) * input.quantity
      : null;
    if (durationSeconds !== null &&
        (!Number.isSafeInteger(durationSeconds) || durationSeconds > MAX_DURATION_SECONDS)) {
      return { kind: "DURATION_LIMIT" } as const;
    }
    // Grant is atomically idempotent in PostgreSQL. Reuse requestId on a retry,
    // including if the first HTTP response was lost. Never touch payment tables.
    return this.entitlements.grant({
      playerId: input.playerId,
      entitlementKey: item.entitlementKey,
      grantModel: item.grantModel,
      durationSeconds,
      sourceType: "ADMIN_DELIVERY",
      sourceId: input.requestId,
      actorType: "ADMIN",
      actorId: actorPrincipalId,
      idempotencyScope: "admin-premium-delivery",
      idempotencyKey: input.requestId,
      metadata: { sku: input.sku, quantity: input.quantity, reason: input.reason },
      correlationId: input.requestId,
    });
  }
}
