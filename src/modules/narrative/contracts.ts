import { z } from "zod";

export const NarrativeActionKindSchema = z.enum(["MOVE", "ITEM", "SWITCH", "FLEE", "WAIT", "OTHER"]);
export type NarrativeActionKind = z.infer<typeof NarrativeActionKindSchema>;

export const NarrativeLegalActionSchema = z
  .object({
    actionId: z.string().min(1).max(128),
    kind: NarrativeActionKindSchema,
    actorId: z.string().min(1).max(128),
    targetIds: z.array(z.string().min(1).max(128)).max(8),
    moveId: z.string().min(1).max(128).nullable(),
    itemId: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type NarrativeLegalAction = z.infer<typeof NarrativeLegalActionSchema>;

export const NarrativeSafeStateSchema = z
  .object({
    sceneKind: z.enum(["FREE_SCENE", "WORLD", "ENCOUNTER", "BATTLE", "SYSTEM"]),
    turnNumber: z.number().int().positive().nullable(),
    locationLabel: z.string().min(1).max(120).nullable(),
    actorLabel: z.string().min(1).max(120),
    targetLabels: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            label: z.string().min(1).max(120),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type NarrativeSafeState = z.infer<typeof NarrativeSafeStateSchema>;

export const NarrativeContextInputSchema = z
  .object({
    sceneId: z.string().min(1).max(128),
    actorId: z.string().min(1).max(128),
    userText: z.string().min(1).max(12_000),
    state: NarrativeSafeStateSchema,
    legalActions: z.array(NarrativeLegalActionSchema).max(32),
  })
  .strict();
export type NarrativeContextInput = z.infer<typeof NarrativeContextInputSchema>;

export const NarrativeProviderContextSchema = z
  .object({
    schemaVersion: z.literal("narrative-context.v1"),
    sceneId: z.string().min(1).max(128),
    actorId: z.string().min(1).max(128),
    userText: z.string().min(1).max(12_000),
    state: NarrativeSafeStateSchema,
    legalActions: z.array(NarrativeLegalActionSchema).max(32),
  })
  .strict();
export type NarrativeProviderContext = z.infer<typeof NarrativeProviderContextSchema>;

export const NarrativeIntentV1Schema = z
  .object({
    version: z.literal("1"),
    actionId: z.string().min(1).max(128).nullable(),
    actorId: z.string().min(1).max(128).nullable(),
    targetId: z.string().min(1).max(128).nullable(),
    moveId: z.string().min(1).max(128).nullable(),
    itemId: z.string().min(1).max(128).nullable(),
    flavor: z.string().max(500),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type NarrativeIntentV1 = z.infer<typeof NarrativeIntentV1Schema>;

export const NarrativeFallbackReasonSchema = z.enum([
  "DISABLED",
  "INPUT_BUDGET",
  "OUTPUT_BUDGET",
  "TIMEOUT",
  "QUOTA",
  "OFFLINE",
  "PROVIDER_ERROR",
  "INVALID_OUTPUT",
  "ILLEGAL_REFERENCE",
  "LOW_CONFIDENCE",
  "CIRCUIT_OPEN",
]);
export type NarrativeFallbackReason = z.infer<typeof NarrativeFallbackReasonSchema>;

export interface NarrativeInterpretation {
  readonly status: "ENRICHED" | "FALLBACK";
  readonly intent: NarrativeIntentV1 | null;
  readonly fallbackReason: NarrativeFallbackReason | null;
  readonly mechanicalAuthority: "NONE";
}

export const ResolvedNarrativeEventSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    kind: z.string().min(1).max(80),
    canonicalText: z.string().min(1).max(1_000),
  })
  .strict();
export type ResolvedNarrativeEvent = z.infer<typeof ResolvedNarrativeEventSchema>;
