import { z } from "zod";

const unlockKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);

const uniqueUnlockKeysSchema = z
  .array(unlockKeySchema)
  .max(32)
  .refine((values) => new Set(values).size === values.length, "unlock keys must be unique");

export const EncounterConditionsSchema = z
  .object({
    schemaVersion: z.literal(1),
    requiredUnlockKeys: uniqueUnlockKeysSchema,
    blockedUnlockKeys: uniqueUnlockKeysSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const blocked = new Set(value.blockedUnlockKeys);
    for (const key of value.requiredUnlockKeys) {
      if (blocked.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["requiredUnlockKeys"],
          message: `unlock key ${key} cannot be both required and blocked`,
        });
      }
    }
  });

export type EncounterConditions = z.infer<typeof EncounterConditionsSchema>;

const OPEN_CONDITIONS: EncounterConditions = Object.freeze({
  schemaVersion: 1,
  requiredUnlockKeys: [],
  blockedUnlockKeys: [],
});

function isLegacyOpenObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

export function parseEncounterConditions(
  value: unknown,
): z.ZodSafeParseResult<EncounterConditions> {
  return EncounterConditionsSchema.safeParse(isLegacyOpenObject(value) ? OPEN_CONDITIONS : value);
}

export function encounterConditionsAllow(
  conditions: EncounterConditions,
  unlockKeys: ReadonlySet<string>,
): boolean {
  if (conditions.requiredUnlockKeys.some((key) => !unlockKeys.has(key))) return false;
  if (conditions.blockedUnlockKeys.some((key) => unlockKeys.has(key))) return false;
  return true;
}
