import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive().safe();
const encounterRngRuntimeSchema = z.object({
  ENCOUNTER_RNG_KEY_BASE64: z.string().min(1),
  ENCOUNTER_RNG_KEY_VERSION: positiveInteger.default(1),
});

export interface EncounterRngRuntimeConfig {
  readonly encryptionKey: Buffer;
  readonly encryptionKeyVersion: number;
}

export class EncounterRngRuntimeConfigError extends Error {
  override readonly name = "EncounterRngRuntimeConfigError";
}

function decodeCanonicalKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32) {
    throw new EncounterRngRuntimeConfigError(
      "ENCOUNTER_RNG_KEY_BASE64 must be canonical base64 for exactly 32 bytes",
    );
  }
  if (decoded.toString("base64") !== value) {
    throw new EncounterRngRuntimeConfigError("ENCOUNTER_RNG_KEY_BASE64 must use canonical base64");
  }
  return decoded;
}

export function loadEncounterRngRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): EncounterRngRuntimeConfig {
  const parsed = encounterRngRuntimeSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new EncounterRngRuntimeConfigError(
      `Invalid Encounter RNG runtime configuration: ${issues}`,
    );
  }

  return {
    encryptionKey: decodeCanonicalKey(parsed.data.ENCOUNTER_RNG_KEY_BASE64),
    encryptionKeyVersion: parsed.data.ENCOUNTER_RNG_KEY_VERSION,
  };
}
