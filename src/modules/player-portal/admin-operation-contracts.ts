import { z } from "zod";

const operationTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const AdminOperationPrepareRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    operationType: operationTypeSchema,
    input: z.record(z.string(), z.unknown()),
    reason: z.string().trim().min(1).max(2000).optional(),
    expectedRevision: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  })
  .strict();

export const AdminOperationApprovalRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
