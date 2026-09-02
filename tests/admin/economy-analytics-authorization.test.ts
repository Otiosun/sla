import { describe, expect, it } from "vitest";
import type { AdminAuthorizationSnapshot, AdminOperationRecord } from "../../src/modules/admin/contracts.js";
import { registerEconomyAnalyticsRead } from "../../src/modules/admin/economy-analytics-definitions.js";
import { ADMIN_ERROR_CODES } from "../../src/modules/admin/errors.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import type { AdminOperationRepository } from "../../src/modules/admin/ports.js";
import { AdminService } from "../../src/modules/admin/service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

class EconomyAuthorizationRepository implements AdminOperationRepository {
  public constructor(private readonly snapshot: AdminAuthorizationSnapshot) {}

  public async getAuthorizationSnapshot(): Promise<AdminAuthorizationSnapshot> {
    return this.snapshot;
  }

  public async createOrReplayOperation(): Promise<never> {
    throw new Error("mutation persistence must not be reached by economy read authorization tests");
  }

  public async getOperation(): Promise<AdminOperationRecord | null> {
    throw new Error("operation lookup must not be reached by economy read authorization tests");
  }

  public async saveSimulation(): Promise<never> {
    throw new Error("simulation must not be reached by economy read authorization tests");
  }

  public async recordConfirmation(): Promise<never> {
    throw new Error("confirmation must not be reached by economy read authorization tests");
  }

  public async recordApproval(): Promise<never> {
    throw new Error("approval must not be reached by economy read authorization tests");
  }
}

function service(snapshot: AdminAuthorizationSnapshot): AdminService {
  const repository = new EconomyAuthorizationRepository(snapshot);
  return new AdminService(registerEconomyAnalyticsRead(new AdminOperationRegistry()), repository);
}

describe("economy analytics authorization", () => {
  it("denies a global principal that has player.read but not economy.read", async () => {
    const admin = service({
      principalId: PRINCIPAL_ID,
      status: "ACTIVE",
      capabilities: [{ key: "player.read", riskTier: 0 }],
      scopes: [{ scopeType: "GLOBAL", scopeId: null }],
    });

    await expect(
      admin.authorizeRead({
        principalId: PRINCIPAL_ID,
        operationType: "economy.analytics.read",
        input: {},
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      message: "Capability denied",
    });
  });
});
