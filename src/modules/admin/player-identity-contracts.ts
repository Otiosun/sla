import { createHash } from "node:crypto";
import { z } from "zod";

export const AdminPlayerWhatsAppChangeInputSchema = z
  .object({
    playerId: z.string().uuid(),
    newIdentityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    newIdentityLast4: z.string().regex(/^\d{4}$/),
  })
  .strict();

export type AdminPlayerWhatsAppChangeInput = z.infer<typeof AdminPlayerWhatsAppChangeInputSchema>;

export const AdminPlayerWhatsAppChangeRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    playerId: z.string().uuid(),
    newWhatsApp: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(2000),
    expectedRevision: z.coerce.bigint().nonnegative(),
    requestId: z.string().uuid(),
  })
  .strict();

export type AdminPlayerWhatsAppChangeRequest = z.infer<
  typeof AdminPlayerWhatsAppChangeRequestSchema
>;

export function adminPlayerIdentityDigest(playerId: string, externalId: string): string {
  return createHash("sha256")
    .update("pokemon-beyond:admin-player-identity-change:v1\0", "utf8")
    .update(playerId, "utf8")
    .update("\0", "utf8")
    .update(externalId, "utf8")
    .digest("hex");
}

export function externalIdentityLast4(externalId: string): string {
  const localPart = externalId.split("@", 1)[0] ?? "";
  const digits = localPart.replace(/\D+/g, "");
  return digits.slice(-4).padStart(4, "•");
}
