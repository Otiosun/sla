import { describe, expect, it } from "vitest";
import {
  AdminIdentityResolver,
  toCloudflareAccessIdentityRef,
  type AdminPrincipalIdentityRecord,
  type AdminPrincipalIdentityRepository,
} from "../../src/adapters/admin-api/identity-resolver.js";
import { AdminRequestAuthenticator } from "../../src/adapters/admin-api/request-authenticator.js";
import type { AdminAuthorizationSnapshot } from "../../src/modules/admin/contracts.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES } from "../../src/modules/admin/errors.js";
import type {
  AdminOperationRepository,
  AdminRoleAssignmentPort,
} from "../../src/modules/admin/ports.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { Player360Service } from "../../src/modules/admin/player360-service.js";
import type { Player360ReadRepository } from "../../src/modules/admin/player360-ports.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const PLAYER_A = "22222222-2222-4222-8222-222222222222";
const PLAYER_B = "33333333-3333-4333-8333-333333333333";
const ISSUER = "https://pokemon-rpg.cloudflareaccess.com";
const TOKEN = "x".repeat(64);

class AuthorizationRepository implements AdminOperationRepository, AdminRoleAssignmentPort {
  public constructor(public snapshot: AdminAuthorizationSnapshot | null) {}

  public async getAuthorizationSnapshot(): Promise<AdminAuthorizationSnapshot | null> {
    return this.snapshot;
  }

  public async createOrReplayOperation(): Promise<never> {
    throw new Error("mutation persistence must not be reached by read authorization tests");
  }

  public async getOperation(): Promise<never> {
    throw new Error("operation lookup must not be reached by read authorization tests");
  }

  public async saveSimulation(): Promise<never> {
    throw new Error("simulation must not be reached by read authorization tests");
  }

  public async recordConfirmation(): Promise<never> {
    throw new Error("confirmation must not be reached by read authorization tests");
  }

  public async recordApproval(): Promise<never> {
    throw new Error("approval must not be reached by read authorization tests");
  }

  public async simulateRoleAssignment(): Promise<never> {
    throw new Error("role mutation must not be reached by read authorization tests");
  }

  public async applyRoleAssignment(): Promise<never> {
    throw new Error("role mutation must not be reached by read authorization tests");
  }
}

class GuardedPlayerRepository implements Player360ReadRepository {
  public getCalls = 0;
  public searchCalls = 0;

  public async getPlayer360(): Promise<null> {
    this.getCalls += 1;
    return null;
  }

  public async searchPlayers(): Promise<never> {
    this.searchCalls += 1;
    throw new Error("repository search must not be reached when authorization is denied");
  }
}

class MutableIdentityRepository implements AdminPrincipalIdentityRepository {
  public status: AdminPrincipalIdentityRecord["status"] = "ACTIVE";

  public async findByIdentityRef(
    identityRef: string,
  ): Promise<AdminPrincipalIdentityRecord | null> {
    return {
      principalId: PRINCIPAL_ID,
      identityRef,
      status: this.status,
    };
  }
}

function adminService(snapshot: AdminAuthorizationSnapshot): AdminService {
  const repository = new AuthorizationRepository(snapshot);
  return new AdminService(createPhase12AdminOperationRegistry(repository), repository);
}

function activeSnapshot(
  capabilities: AdminAuthorizationSnapshot["capabilities"],
  scopes: AdminAuthorizationSnapshot["scopes"],
): AdminAuthorizationSnapshot {
  return {
    principalId: PRINCIPAL_ID,
    status: "ACTIVE",
    capabilities,
    scopes,
  };
}

describe("Admin API adversarial authorization", () => {
  it("re-checks internal principal state on every request so a still-valid external token is killed immediately", async () => {
    const identityRepository = new MutableIdentityRepository();
    const identity = {
      provider: "cloudflare-access" as const,
      issuer: ISSUER,
      subject: "stable-access-subject",
      email: "admin@example.com",
    };
    const resolver = new AdminIdentityResolver(identityRepository, "staging");
    const authenticator = new AdminRequestAuthenticator(
      {
        verify: async () => ({
          identity,
          issuedAt: new Date("2026-08-31T12:00:00.000Z"),
          notBefore: new Date("2026-08-31T12:00:00.000Z"),
          expiresAt: new Date("2026-08-31T13:00:00.000Z"),
        }),
      },
      resolver,
    );

    await expect(authenticator.authenticate(TOKEN)).resolves.toMatchObject({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      identityRef: toCloudflareAccessIdentityRef(identity),
    });

    identityRepository.status = "DISABLED";

    await expect(authenticator.authenticate(TOKEN)).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      message: "Administrative access denied",
    });
  });

  it("blocks BOLA when a player-scoped principal requests another player", async () => {
    const service = adminService(
      activeSnapshot(
        [{ key: "player.read", riskTier: 0 }],
        [{ scopeType: "PLAYER", scopeId: PLAYER_A }],
      ),
    );

    await expect(
      service.authorizeRead({
        principalId: PRINCIPAL_ID,
        operationType: "player.read",
        input: { playerId: PLAYER_B },
      }),
    ).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      message: "Object scope denied",
    });
  });

  it("blocks collection search for a principal that has capability but lacks GLOBAL scope", async () => {
    const service = adminService(
      activeSnapshot(
        [{ key: "player.read", riskTier: 0 }],
        [{ scopeType: "PLAYER", scopeId: PLAYER_A }],
      ),
    );

    await expect(
      service.authorizeRead({
        principalId: PRINCIPAL_ID,
        operationType: "player.search",
        input: {},
      }),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED });
  });

  it("blocks BFLA when the principal lacks the capability required by the registered operation", async () => {
    const service = adminService(activeSnapshot([], [{ scopeType: "GLOBAL", scopeId: null }]));

    await expect(
      service.authorizeRead({
        principalId: PRINCIPAL_ID,
        operationType: "player.read",
        input: { playerId: PLAYER_A },
      }),
    ).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      message: "Capability denied",
    });
  });

  it("never reaches Player360 persistence when sensitive read capability is missing", async () => {
    const authorizer = adminService(
      activeSnapshot(
        [{ key: "player.read", riskTier: 0 }],
        [{ scopeType: "GLOBAL", scopeId: null }],
      ),
    );
    const repository = new GuardedPlayerRepository();
    const service = new Player360Service(authorizer, repository);

    await expect(
      service.get({
        principalId: PRINCIPAL_ID,
        playerId: PLAYER_A,
        includeSensitive: true,
      }),
    ).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      message: "Capability denied",
    });
    expect(repository.getCalls).toBe(0);
    expect(repository.searchCalls).toBe(0);
  });
});
