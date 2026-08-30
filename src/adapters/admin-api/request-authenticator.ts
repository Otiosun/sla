import { z } from "zod";
import type {
  CloudflareAccessIdentity,
  ResolvedAdminIdentityContext,
} from "./identity-resolver.js";

const AccessTokenSchema = z.string().trim().min(32).max(16_384);

export class AdminUnauthenticatedError extends Error {
  override readonly name = "AdminUnauthenticatedError";
}

export interface AdminAccessIdentityVerifier {
  verify(token: string): Promise<CloudflareAccessIdentity>;
}

export interface AdminInternalIdentityResolver {
  resolve(identity: CloudflareAccessIdentity): Promise<ResolvedAdminIdentityContext>;
}

export class AdminRequestAuthenticator {
  public constructor(
    private readonly verifier: AdminAccessIdentityVerifier,
    private readonly resolver: AdminInternalIdentityResolver,
  ) {}

  public async authenticate(rawToken: unknown): Promise<ResolvedAdminIdentityContext> {
    const parsed = AccessTokenSchema.safeParse(rawToken);
    if (!parsed.success) throw new AdminUnauthenticatedError("Administrative authentication failed");

    let externalIdentity: CloudflareAccessIdentity;
    try {
      externalIdentity = await this.verifier.verify(parsed.data);
    } catch {
      throw new AdminUnauthenticatedError("Administrative authentication failed");
    }

    return this.resolver.resolve(externalIdentity);
  }
}
