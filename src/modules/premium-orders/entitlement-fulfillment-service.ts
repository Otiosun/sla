import { z } from "zod";
import type { EntitlementService } from "../entitlements/service.js";
import type { PremiumFulfillmentResult } from "./contracts.js";
import type { PremiumOrderRepository } from "./ports.js";

const EntitlementPayloadSchema = z
  .object({
    entitlementKey: z.string().regex(/^[A-Z0-9][A-Z0-9_.:-]{1,127}$/),
    grantModel: z.literal("TIMED"),
    durationSecondsPerUnit: z.number().int().positive().max(10 * 365 * 24 * 60 * 60),
  })
  .strict();

export type PremiumEntitlementFulfillmentResult =
  | { readonly kind: "APPLIED"; readonly replayed: boolean; readonly fulfillment: PremiumFulfillmentResult }
  | { readonly kind: "ORDER_NOT_FOUND" }
  | { readonly kind: "ITEM_NOT_FOUND" }
  | { readonly kind: "ORDER_NOT_PAID"; readonly status: string }
  | { readonly kind: "UNSUPPORTED_FULFILLMENT"; readonly fulfillmentKind: string }
  | { readonly kind: "INVALID_FULFILLMENT_PAYLOAD" }
  | { readonly kind: "ENTITLEMENT_GRANT_FAILED"; readonly reason: string }
  | { readonly kind: "FULFILLMENT_RECORD_FAILED"; readonly reason: string };

export class PremiumEntitlementFulfillmentService {
  public constructor(
    private readonly orders: PremiumOrderRepository,
    private readonly entitlements: EntitlementService,
  ) {}

  public async fulfillOrderItem(input: {
    readonly orderId: string;
    readonly orderItemId: string;
    readonly correlationId: string | null;
  }): Promise<PremiumEntitlementFulfillmentResult> {
    const order = await this.orders.getOrder(input.orderId);
    if (order === null) return { kind: "ORDER_NOT_FOUND" };

    const item = order.items.find((candidate) => candidate.id === input.orderItemId);
    if (item === undefined) return { kind: "ITEM_NOT_FOUND" };

    if (order.status !== "PAID" && !item.fulfilled) {
      return { kind: "ORDER_NOT_PAID", status: order.status };
    }

    if (item.fulfillmentKind !== "ENTITLEMENT") {
      return {
        kind: "UNSUPPORTED_FULFILLMENT",
        fulfillmentKind: item.fulfillmentKind,
      };
    }

    const parsed = EntitlementPayloadSchema.safeParse(item.fulfillmentPayload);
    if (!parsed.success) return { kind: "INVALID_FULFILLMENT_PAYLOAD" };

    const durationSeconds = parsed.data.durationSecondsPerUnit * item.quantity;
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds > 10 * 365 * 24 * 60 * 60) {
      return { kind: "INVALID_FULFILLMENT_PAYLOAD" };
    }

    const grant = await this.entitlements.grant({
      playerId: order.playerId,
      entitlementKey: parsed.data.entitlementKey,
      grantModel: parsed.data.grantModel,
      durationSeconds,
      sourceType: "PREMIUM_ORDER",
      sourceId: `${order.id}:${item.id}`,
      actorType: "SYSTEM",
      actorId: null,
      idempotencyScope: "premium-order-entitlement",
      idempotencyKey: item.id,
      metadata: {
        orderId: order.id,
        orderHumanId: order.humanId,
        orderItemId: item.id,
        sku: item.sku,
        quantity: item.quantity,
      },
      correlationId: input.correlationId,
    });

    if (grant.kind !== "APPLIED") {
      return { kind: "ENTITLEMENT_GRANT_FAILED", reason: grant.kind };
    }

    const fulfillment = await this.orders.recordFulfillment({
      orderId: order.id,
      orderItemId: item.id,
      fulfillmentKey: `premium-entitlement:${item.id}`,
      result: {
        entitlementKey: grant.entitlement.entitlementKey,
        startsAt: grant.entitlement.startsAt,
        expiresAt: grant.entitlement.expiresAt,
        entitlementRevision: grant.entitlement.revision,
      },
      correlationId: input.correlationId,
    });

    if (fulfillment.kind !== "APPLIED") {
      return { kind: "FULFILLMENT_RECORD_FAILED", reason: fulfillment.kind };
    }

    return {
      kind: "APPLIED",
      replayed: grant.replayed || fulfillment.replayed,
      fulfillment,
    };
  }
}
