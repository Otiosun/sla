import { z } from "zod";

export const EntitlementGrantModelSchema = z.enum(["PERMANENT", "TIMED"]);
export type EntitlementGrantModel = z.infer<typeof EntitlementGrantModelSchema>;

export const EntitlementGrantInputSchema = z
  .object({
    playerId: z.string().uuid(),
    entitlementKey: z.string().regex(/^[A-Z0-9][A-Z0-9_.:-]{1,127}$/),
    grantModel: EntitlementGrantModelSchema,
    durationSeconds: z.number().int().positive().max(10 * 365 * 24 * 60 * 60).nullable(),
    sourceType: z.string().min(1).max(64),
    sourceId: z.string().min(1).max(256),
    actorType: z.enum(["SYSTEM", "ADMIN"]),
    actorId: z.string().uuid().nullable(),
    idempotencyScope: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(512),
    metadata: z.record(z.string(), z.unknown()).default({}),
    correlationId: z.string().uuid().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.grantModel === "PERMANENT" && value.durationSeconds !== null) {
      context.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: "Permanent entitlements cannot declare durationSeconds",
      });
    }
    if (value.grantModel === "TIMED" && value.durationSeconds === null) {
      context.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: "Timed entitlements require durationSeconds",
      });
    }
    if (value.actorType === "ADMIN" && value.actorId === null) {
      context.addIssue({
        code: "custom",
        path: ["actorId"],
        message: "Admin grants require actorId",
      });
    }
  });

export type EntitlementGrantInput = z.infer<typeof EntitlementGrantInputSchema>;

export interface PlayerEntitlementView {
  readonly playerId: string;
  readonly entitlementKey: string;
  readonly grantModel: EntitlementGrantModel;
  readonly administrativeStatus: "ACTIVE" | "REVOKED";
  readonly startsAt: string;
  readonly expiresAt: string | null;
  readonly revision: string;
  readonly currentlyActive: boolean;
}

export type EntitlementGrantResult =
  | { readonly kind: "APPLIED"; readonly replayed: boolean; readonly entitlement: PlayerEntitlementView }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "PLAYER_NOT_FOUND" }
  | { readonly kind: "DEFINITION_NOT_FOUND" }
  | { readonly kind: "DEFINITION_INACTIVE" }
  | { readonly kind: "GRANT_MODEL_MISMATCH" };
