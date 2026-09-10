import { z } from "zod";
import type { AppConfig } from "../platform/config/env.js";

const fullRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
const runtimeSchema = z.object({
  PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: z.string().min(1),
  ENCOUNTER_RNG_KEY_BASE64: z.string().min(1),
  ENCOUNTER_RNG_KEY_VERSION: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  PLAYER_PORTAL_HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DEPLOY_REVISION: fullRevisionSchema.optional(),
  RAILWAY_GIT_COMMIT_SHA: fullRevisionSchema.optional(),
});

export interface PlayerPortalRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly sessionSigningKey: Buffer;
  readonly encounterRngKey: Buffer;
  readonly encounterRngKeyVersion: number;
  readonly deploymentRevision: string | null;
}

export class PlayerPortalRuntimeConfigError extends Error {
  override readonly name = "PlayerPortalRuntimeConfigError";
}

function decodeCanonicalKey(value: string, variableName: string): Buffer {
  const encoded = value.trim();
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== encoded) {
    throw new PlayerPortalRuntimeConfigError(
      `${variableName} must be canonical base64 for exactly 32 bytes`,
    );
  }
  return decoded;
}

export function loadPlayerPortalRuntimeConfig(
  appConfig: Pick<AppConfig, "appEnv">,
  env: NodeJS.ProcessEnv = process.env,
): PlayerPortalRuntimeConfig {
  const parsed = runtimeSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new PlayerPortalRuntimeConfigError(
      `Invalid Player Portal runtime configuration: ${issues}`,
    );
  }

  const explicitRevision = parsed.data.DEPLOY_REVISION;
  const railwayRevision = parsed.data.RAILWAY_GIT_COMMIT_SHA;
  if (
    explicitRevision !== undefined &&
    railwayRevision !== undefined &&
    explicitRevision !== railwayRevision
  ) {
    throw new PlayerPortalRuntimeConfigError(
      "Invalid Player Portal runtime configuration: DEPLOY_REVISION disagrees with RAILWAY_GIT_COMMIT_SHA",
    );
  }

  const deploymentRevision = railwayRevision ?? explicitRevision ?? null;
  const requiresRevision = appConfig.appEnv === "staging" || appConfig.appEnv === "production";
  if (requiresRevision && deploymentRevision === null) {
    throw new PlayerPortalRuntimeConfigError(
      "Invalid Player Portal runtime configuration: deployment revision is required in staging/production",
    );
  }

  return {
    host: parsed.data.PLAYER_PORTAL_HOST,
    port: parsed.data.PORT,
    sessionSigningKey: decodeCanonicalKey(
      parsed.data.PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64,
      "PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64",
    ),
    encounterRngKey: decodeCanonicalKey(
      parsed.data.ENCOUNTER_RNG_KEY_BASE64,
      "ENCOUNTER_RNG_KEY_BASE64",
    ),
    encounterRngKeyVersion: parsed.data.ENCOUNTER_RNG_KEY_VERSION,
    deploymentRevision,
  };
}
