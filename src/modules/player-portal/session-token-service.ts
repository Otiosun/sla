import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ExternalIdentitySchema, type ExternalIdentity } from "../player/contracts.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

const HUB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const HubSessionPayloadSchema = z
  .object({
    v: z.literal(1),
    identity: ExternalIdentitySchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((payload) => payload.exp > payload.iat);

type HubSessionPayload = z.infer<typeof HubSessionPayloadSchema>;

export interface HubSessionIssueResult {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface HubSessionTokenDependencies {
  readonly signingKey: Uint8Array;
  readonly now?: () => Date;
}

export class HubSessionTokenService {
  private readonly signingKey: Buffer;
  private readonly now: () => Date;

  public constructor(dependencies: HubSessionTokenDependencies) {
    if (dependencies.signingKey.byteLength < 32) {
      throw new Error("Hub session signing key must contain at least 32 bytes");
    }
    this.signingKey = Buffer.from(dependencies.signingKey);
    this.now = dependencies.now ?? (() => new Date());
  }

  public issue(identity: ExternalIdentity): Result<HubSessionIssueResult> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return err(appError("VALIDATION_FAILED", "Invalid external identity"));
    }

    const now = this.now();
    const expiresAt = new Date(now.getTime() + HUB_SESSION_TTL_MS);
    const payload: HubSessionPayload = {
      v: 1,
      identity: parsedIdentity.data,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = sign(encodedPayload, this.signingKey).toString("base64url");

    return ok({
      token: `${encodedPayload}.${signature}`,
      expiresAt,
    });
  }

  public verify(token: string): Result<ExternalIdentity> {
    const parts = token.split(".");
    if (parts.length !== 2) return sessionUnavailable();
    const [encodedPayload, encodedSignature] = parts;
    if (
      !encodedPayload ||
      !encodedSignature ||
      !BASE64URL_PATTERN.test(encodedPayload) ||
      !BASE64URL_PATTERN.test(encodedSignature)
    ) {
      return sessionUnavailable();
    }

    const expectedSignature = sign(encodedPayload, this.signingKey);
    const providedSignature = Buffer.from(encodedSignature, "base64url");
    if (
      providedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      return sessionUnavailable();
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      return sessionUnavailable();
    }

    const payload = HubSessionPayloadSchema.safeParse(decoded);
    if (!payload.success) return sessionUnavailable();
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (payload.data.exp <= nowSeconds) return sessionUnavailable();

    return ok(payload.data.identity);
  }
}

function sign(payload: string, signingKey: Buffer): Buffer {
  return createHmac("sha256", signingKey).update(payload).digest();
}

function sessionUnavailable(): Result<never> {
  return err(appError("NOT_FOUND", "Hub session unavailable"));
}
