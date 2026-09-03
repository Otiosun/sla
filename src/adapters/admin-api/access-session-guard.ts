import type { Clock } from "../../platform/clock/index.js";
import {
  AdminUnauthenticatedError,
  type AuthenticatedAdminRequestContext,
} from "./request-authenticator.js";

export interface AdminAccessSessionUseRequest {
  readonly principalId: string;
  readonly environment: AuthenticatedAdminRequestContext["environment"];
  readonly tokenFingerprint: string;
  readonly accessIssuedAt: Date;
  readonly accessNotBefore: Date;
  readonly accessExpiresAt: Date;
  readonly observedAt: Date;
  readonly idleExpiresAt: Date;
}

export type AdminAccessSessionUseDecision = "ACTIVE" | "DENIED";

export interface AdminAccessSessionRepository {
  useSession(request: AdminAccessSessionUseRequest): Promise<AdminAccessSessionUseDecision>;
}

function invalidSession(): AdminUnauthenticatedError {
  return new AdminUnauthenticatedError("Administrative session is not active");
}

export class AdminAccessSessionGuard {
  public constructor(
    private readonly repository: AdminAccessSessionRepository,
    private readonly clock: Clock,
    private readonly idleTimeoutMs: number,
  ) {
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new RangeError("Admin access session idle timeout must be a positive safe integer");
    }
  }

  public async authorize(
    context: AuthenticatedAdminRequestContext,
  ): Promise<AuthenticatedAdminRequestContext> {
    const observedAt = this.clock.now();
    const observedMs = observedAt.getTime();
    const notBeforeMs = context.accessSession.notBefore.getTime();
    const accessExpiresMs = context.accessSession.expiresAt.getTime();

    if (
      !Number.isFinite(observedMs) ||
      !Number.isFinite(notBeforeMs) ||
      !Number.isFinite(accessExpiresMs) ||
      observedMs < notBeforeMs ||
      observedMs >= accessExpiresMs
    ) {
      throw invalidSession();
    }

    const idleExpiresAt = new Date(Math.min(observedMs + this.idleTimeoutMs, accessExpiresMs));
    const decision = await this.repository.useSession({
      principalId: context.principalId,
      environment: context.environment,
      tokenFingerprint: context.accessSession.tokenFingerprint,
      accessIssuedAt: context.accessSession.issuedAt,
      accessNotBefore: context.accessSession.notBefore,
      accessExpiresAt: context.accessSession.expiresAt,
      observedAt,
      idleExpiresAt,
    });

    if (decision !== "ACTIVE") throw invalidSession();
    return context;
  }
}
