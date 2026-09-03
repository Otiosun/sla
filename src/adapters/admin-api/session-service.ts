import type { AdminAuthorizationSnapshot, AdminScope } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type { ResolvedAdminIdentityContext } from "./identity-resolver.js";

export interface AdminAuthorizationSnapshotReader {
  getAuthorizationSnapshot(principalId: string): Promise<AdminAuthorizationSnapshot | null>;
}

export interface AdminSessionRoleReader {
  listRoleSlugs(principalId: string): Promise<readonly string[]>;
}

export interface AdminSessionProjection {
  readonly principalId: string;
  readonly roles: readonly string[];
  readonly capabilities: readonly {
    readonly key: string;
    readonly riskTier: 0 | 1 | 2 | 3 | 4;
  }[];
  readonly scopes: readonly AdminScope[];
  readonly environment: "development" | "staging" | "production";
}

export class AdminSessionService {
  public constructor(
    private readonly authorization: AdminAuthorizationSnapshotReader,
    private readonly roles: AdminSessionRoleReader,
  ) {}

  public async getSession(identity: ResolvedAdminIdentityContext): Promise<AdminSessionProjection> {
    const snapshot = await this.authorization.getAuthorizationSnapshot(identity.principalId);
    if (snapshot === null || snapshot.status !== "ACTIVE") {
      throw new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Administrative access denied");
    }

    const roleSlugs = await this.roles.listRoleSlugs(identity.principalId);
    return {
      principalId: snapshot.principalId,
      roles: [...roleSlugs].sort(),
      capabilities: snapshot.capabilities.map((capability) => ({
        key: capability.key,
        riskTier: capability.riskTier,
      })),
      scopes: snapshot.scopes.map((scope) => ({ ...scope })),
      environment: identity.environment,
    };
  }
}
