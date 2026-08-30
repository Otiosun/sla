import { z } from "zod";
import type { CloudflareAccessIdentity } from "./identity-resolver.js";
import type { ResolvedAdminIdentityContext } from "./identity-resolver.js";

const AccessTokenSchema = z.string().trim().min(32).max(16_384);

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
    const token = AccessTokenSchema.parse(rawToken);
    const externalIdentity = await this.verifier.verify(token);
    return this.resolver.resolve(externalIdentity);
  }
}
