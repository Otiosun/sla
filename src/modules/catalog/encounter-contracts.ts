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
    timeOfDay: z.enum(["DAY", "NIGHT"]).optional(),
    surface: z.enum(["LAND", "WATER"]).optional(),
    rarity: z.enum(["COMMON", "RARE"]).optional(),
    weatherKey: unlockKeySchema.optional(),
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

export interface EncounterEnvironmentContext {
  readonly timeOfDay?: "DAY" | "NIGHT";
  readonly surface?: "LAND" | "WATER";
  readonly rarity?: "COMMON" | "RARE";
  readonly weatherKey?: string;
}

export interface EncounterConditions {
  readonly schemaVersion: 1;
  readonly requiredUnlockKeys: readonly string[];
  readonly blockedUnlockKeys: readonly string[];
  readonly timeOfDay?: "DAY" | "NIGHT" | undefined;
  readonly surface?: "LAND" | "WATER" | undefined;
  readonly rarity?: "COMMON" | "RARE" | undefined;
  readonly weatherKey?: string | undefined;
}

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
  environment: EncounterEnvironmentContext = {},
): boolean {
  if (conditions.requiredUnlockKeys.some((key) => !unlockKeys.has(key))) return false;
  if (conditions.blockedUnlockKeys.some((key) => unlockKeys.has(key))) return false;
  if (conditions.timeOfDay !== undefined && environment.timeOfDay !== conditions.timeOfDay) {
    return false;
  }
  if (conditions.surface !== undefined && environment.surface !== conditions.surface) {
    return false;
  }
  if (conditions.rarity !== undefined && environment.rarity !== conditions.rarity) {
    return false;
  }
  if (conditions.weatherKey !== undefined && environment.weatherKey !== conditions.weatherKey) {
    return false;
  }
  return true;
}
