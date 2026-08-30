import { z } from "zod";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type {
  CloudflareAccessIdentity,
  ResolvedAdminIdentityContext,
} from "./identity-resolver.js";

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
    const parsed = AccessTokenSchema.safeParse(rawToken);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Administrative access denied");
    }
    const externalIdentity = await this.verifier.verify(parsed.data);
    return this.resolver.resolve(externalIdentity);
  }
}
