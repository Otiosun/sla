import { z } from "zod";
import type { EncounterRulesetPolicy } from "./contracts.js";

const captureStartStatusSchema = z.enum(["ENGAGED", "IN_BATTLE"]);

const encounterPolicySourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    encounter: z
      .object({
        expirationSeconds: z.number().int().min(30).max(86_400),
      })
      .strict()
      .optional(),
    capture: z
      .object({
        allowedEncounterStates: z.array(captureStartStatusSchema).min(1).max(2).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const V1_DEFAULT_EXPIRATION_SECONDS = 15 * 60;
const V1_DEFAULT_CAPTURE_STATES = ["IN_BATTLE"] as const;

export function resolveEncounterRulesetPolicy(config: unknown): EncounterRulesetPolicy {
  const parsed = encounterPolicySourceSchema.parse(config);
  return {
    expirationSeconds: parsed.encounter?.expirationSeconds ?? V1_DEFAULT_EXPIRATION_SECONDS,
    captureAllowedStates:
      parsed.capture.allowedEncounterStates === undefined
        ? V1_DEFAULT_CAPTURE_STATES
        : parsed.capture.allowedEncounterStates,
  };
}
