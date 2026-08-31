import { createHash } from "node:crypto";
import { z } from "zod";
import type { VerifiedCloudflareAccessAssertion } from "./cloudflare-access-verifier.js";
import type {
  CloudflareAccessIdentity,
  ResolvedAdminIdentityContext,
} from "./identity-resolver.js";

const AccessTokenSchema = z.string().trim().min(32).max(16_384);

export class AdminUnauthenticatedError extends Error {
  override readonly name = "AdminUnauthenticatedError";
}

export interface AdminAccessIdentityVerifier {
  verify(token: string): Promise<VerifiedCloudflareAccessAssertion>;
}

export interface AdminInternalIdentityResolver {
  resolve(identity: CloudflareAccessIdentity): Promise<ResolvedAdminIdentityContext>;
}

export interface AdminAccessSessionContext {
  readonly tokenFingerprint: string;
  readonly issuedAt: Date;
  readonly notBefore: Date;
  readonly expiresAt: Date;
}

export interface AuthenticatedAdminRequestContext extends ResolvedAdminIdentityContext {
  readonly accessSession: AdminAccessSessionContext;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class AdminRequestAuthenticator {
  public constructor(
    private readonly verifier: AdminAccessIdentityVerifier,
    private readonly resolver: AdminInternalIdentityResolver,
  ) {}

  public async authenticate(rawToken: unknown): Promise<AuthenticatedAdminRequestContext> {
    const parsed = AccessTokenSchema.safeParse(rawToken);
    if (!parsed.success)
      throw new AdminUnauthenticatedError("Administrative authentication failed");

    let assertion: VerifiedCloudflareAccessAssertion;
    try {
      assertion = await this.verifier.verify(parsed.data);
    } catch {
      throw new AdminUnauthenticatedError("Administrative authentication failed");
    }

    const resolved = await this.resolver.resolve(assertion.identity);
    return {
      ...resolved,
      accessSession: {
        tokenFingerprint: tokenFingerprint(parsed.data),
        issuedAt: assertion.issuedAt,
        notBefore: assertion.notBefore,
        expiresAt: assertion.expiresAt,
      },
    };
  }
}
