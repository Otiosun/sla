import type { AdminAuthorizationSnapshotReader } from "./session-service.js";
import {
  AdminUnauthenticatedError,
  type AuthenticatedAdminRequestContext,
} from "./request-authenticator.js";

function unauthenticated(): AdminUnauthenticatedError {
  return new AdminUnauthenticatedError("Administrative authentication failed");
}

export class LocalDevAdminRequestAuthenticator {
  public constructor(
    private readonly principalId: string,
    private readonly authorization: AdminAuthorizationSnapshotReader,
  ) {}

  public async authenticate(
    rawToken: unknown,
  ): Promise<AuthenticatedAdminRequestContext> {
    if (rawToken !== undefined && rawToken !== null) throw unauthenticated();

    const snapshot = await this.authorization.getAuthorizationSnapshot(this.principalId);
    if (snapshot === null || snapshot.status !== "ACTIVE") throw unauthenticated();

    const issuedAt = new Date();
    return {
      principalId: snapshot.principalId,
      environment: "development",
      identityRef: `local-development:${snapshot.principalId}`,
      displayEmail: null,
      accessSession: {
        tokenFingerprint: `local-dev:${snapshot.principalId}`,
        issuedAt,
        notBefore: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 86_400_000),
      },
    };
  }
}

export class LocalDevAdminSessionGuard {
  public constructor(private readonly principalId: string) {}

  public async authorize(
    context: AuthenticatedAdminRequestContext,
  ): Promise<AuthenticatedAdminRequestContext> {
    if (
      context.environment !== "development" ||
      context.principalId !== this.principalId ||
      context.identityRef !== `local-development:${this.principalId}` ||
      context.accessSession.tokenFingerprint !== `local-dev:${this.principalId}`
    ) {
      throw unauthenticated();
    }
    return context;
  }
}
