import { z } from "zod";

export const AdminPlayerWhatsAppIdentityChangeRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    newWhatsApp: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(2000),
    expectedRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
    confirmed: z.literal(true),
  })
  .strict();

export type AdminPlayerWhatsAppIdentityChangeRequest = z.infer<
  typeof AdminPlayerWhatsAppIdentityChangeRequestSchema
>;
