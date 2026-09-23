import type { AdminAuthorizationSnapshot } from "../admin/contracts.js";
import type { ExternalIdentity } from "../player/contracts.js";

interface AdminIdentityResolver {
  resolvePrincipal(input: ExternalIdentity): Promise<{ readonly principalId: string } | null>;
}

interface AdminAuthorizationReader {
  getAuthorizationSnapshot(principalId: string): Promise<AdminAuthorizationSnapshot | null>;
}

export interface PlayerPortalAdminAccess {
  readonly capabilities: readonly {
    readonly key: string;
    readonly riskTier: number;
  }[];
  readonly scopes: readonly {
    readonly scopeType: "GLOBAL" | "PLAYER" | "REGION" | "AREA";
    readonly scopeId: string | null;
  }[];
}

export class PlayerPortalAdminAccessService {
  public constructor(
    private readonly identities: AdminIdentityResolver,
    private readonly authorization: AdminAuthorizationReader,
  ) {}

  public async get(identity: ExternalIdentity): Promise<PlayerPortalAdminAccess | null> {
    const principal = await this.identities.resolvePrincipal(identity);
    if (principal === null) return null;

    const snapshot = await this.authorization.getAuthorizationSnapshot(principal.principalId);
    if (snapshot === null || snapshot.status !== "ACTIVE" || snapshot.capabilities.length === 0) {
      return null;
    }

    return {
      capabilities: snapshot.capabilities.map((capability) => ({
        key: capability.key,
        riskTier: capability.riskTier,
      })),
      scopes: snapshot.scopes.map((scope) => ({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
      })),
    };
  }
}
