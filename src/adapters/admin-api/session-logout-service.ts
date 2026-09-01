import type { Clock } from "../../platform/clock/index.js";
import {
  AdminUnauthenticatedError,
  type AuthenticatedAdminRequestContext,
} from "./request-authenticator.js";

export const CLOUDFLARE_ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

export interface AdminAccessSessionRevocationRequest {
  readonly tokenFingerprint: string;
  readonly revokedAt: Date;
  readonly revokedByPrincipalId: string | null;
  readonly reason: string;
}

export interface AdminAccessSessionRevoker {
  revokeSession(request: AdminAccessSessionRevocationRequest): Promise<boolean>;
}

function inactiveSession(): AdminUnauthenticatedError {
  return new AdminUnauthenticatedError("Administrative session is not active");
}

export class AdminSessionLogoutService {
  public constructor(
    private readonly revoker: AdminAccessSessionRevoker,
    private readonly clock: Clock,
  ) {}

  public async logoutCurrent(
    context: AuthenticatedAdminRequestContext,
  ): Promise<{ readonly logoutPath: typeof CLOUDFLARE_ACCESS_LOGOUT_PATH }> {
    const revokedAt = this.clock.now();
    if (!Number.isFinite(revokedAt.getTime())) throw inactiveSession();

    const revoked = await this.revoker.revokeSession({
      tokenFingerprint: context.accessSession.tokenFingerprint,
      revokedAt,
      revokedByPrincipalId: context.principalId,
      reason: "SELF_LOGOUT",
    });
    if (!revoked) throw inactiveSession();

    return { logoutPath: CLOUDFLARE_ACCESS_LOGOUT_PATH };
  }
}
