import { z } from "zod";

const unlockKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);

export const WorldAreaKindSchema = z.enum(["TOWN", "CITY", "ROUTE", "FACILITY", "OTHER"]);
export type WorldAreaKind = z.infer<typeof WorldAreaKindSchema>;

export const WorldAreaConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: WorldAreaKindSchema,
    safePoint: z.boolean(),
    startingArea: z.boolean(),
    relocationPriority: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type WorldAreaConfig = z.infer<typeof WorldAreaConfigSchema>;

export const ConnectionAccessRuleSchema = z
  .object({
    schemaVersion: z.literal(1),
    requiredUnlockKeys: z.array(unlockKeySchema).max(32),
  })
  .strict();
export type ConnectionAccessRule = z.infer<typeof ConnectionAccessRuleSchema>;
