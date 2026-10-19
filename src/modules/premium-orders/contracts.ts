import { z } from "zod";

export const PremiumOrderStatusSchema = z.enum(["PENDING", "PAID", "APPLIED", "CANCELLED"]);
export type PremiumOrderStatus = z.infer<typeof PremiumOrderStatusSchema>;

export const PremiumFulfillmentKindSchema = z.enum(["ENTITLEMENT", "POKEMON_PACKAGE", "MANUAL"]);
export type PremiumFulfillmentKind = z.infer<typeof PremiumFulfillmentKindSchema>;

export const CreatePremiumOrderInputSchema = z
  .object({
    playerId: z.string().uuid(),
    items: z
      .array(
        z
          .object({
            sku: z.string().regex(/^[A-Z0-9][A-Z0-9_.:-]{1,127}$/),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    idempotencyScope: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(512),
    metadata: z.record(z.string(), z.unknown()).default({}),
    correlationId: z.string().uuid().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      if (seen.has(item.sku)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "sku"],
          message: "Duplicate SKU lines are not allowed; use quantity instead",
        });
      }
      seen.add(item.sku);
    });
  });

export type CreatePremiumOrderInput = z.infer<typeof CreatePremiumOrderInputSchema>;

export const PremiumPaymentEventInputSchema = z
  .object({
    orderId: z.string().uuid(),
    provider: z.string().min(1).max(64),
    externalEventId: z.string().min(1).max(256),
    eventType: z.enum(["PAID", "CANCELLED"]),
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    payloadDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    // Optional compare-and-set constraint used by owner-approved manual events.
    expectedRevision: z.string().regex(/^[0-9]{1,20}$/).optional(),
    correlationId: z.string().uuid().nullable(),
  })
  .strict();

export type PremiumPaymentEventInput = z.infer<typeof PremiumPaymentEventInputSchema>;

export const RecordPremiumFulfillmentInputSchema = z
  .object({
    orderId: z.string().uuid(),
    orderItemId: z.string().uuid(),
    fulfillmentKey: z.string().min(1).max(512),
    result: z.record(z.string(), z.unknown()).default({}),
    correlationId: z.string().uuid().nullable(),
  })
  .strict();

export type RecordPremiumFulfillmentInput = z.infer<typeof RecordPremiumFulfillmentInputSchema>;

export interface PremiumOrderItemView {
  readonly id: string;
  readonly lineNo: number;
  readonly sku: string;
  readonly title: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly lineTotalCents: number;
  readonly fulfillmentKind: PremiumFulfillmentKind;
  readonly fulfillmentPayload: Readonly<Record<string, unknown>>;
  readonly fulfilled: boolean;
}

export interface PremiumOrderView {
  readonly id: string;
  readonly humanId: string;
  readonly playerId: string;
  readonly status: PremiumOrderStatus;
  readonly currency: string;
  readonly totalCents: number;
  readonly revision: string;
  readonly createdAt: string;
  readonly paidAt: string | null;
  readonly appliedAt: string | null;
  readonly cancelledAt: string | null;
  readonly items: readonly PremiumOrderItemView[];
}

export type CreatePremiumOrderResult =
  | { readonly kind: "CREATED"; readonly replayed: boolean; readonly order: PremiumOrderView }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "PLAYER_NOT_FOUND" }
  | { readonly kind: "PRODUCT_NOT_FOUND"; readonly sku: string }
  | { readonly kind: "PRODUCT_INACTIVE"; readonly sku: string }
  | { readonly kind: "QUANTITY_LIMIT"; readonly sku: string; readonly maxQuantity: number }
  | { readonly kind: "MIXED_CURRENCY" };

export type PremiumPaymentEventResult =
  | { readonly kind: "APPLIED"; readonly replayed: boolean; readonly order: PremiumOrderView }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "ORDER_NOT_FOUND" }
  | { readonly kind: "PAYMENT_MISMATCH" }
  | { readonly kind: "STATE_CONFLICT"; readonly status: PremiumOrderStatus };

export type PremiumFulfillmentResult =
  | { readonly kind: "APPLIED"; readonly replayed: boolean; readonly order: PremiumOrderView }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "ORDER_NOT_FOUND" }
  | { readonly kind: "ITEM_NOT_FOUND" }
  | { readonly kind: "ORDER_NOT_PAID"; readonly status: PremiumOrderStatus }
  | { readonly kind: "ITEM_ALREADY_FULFILLED" };
