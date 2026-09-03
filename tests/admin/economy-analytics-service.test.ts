import { describe, expect, it, vi } from "vitest";
import type { AdminOperationRepository } from "../../src/modules/admin/ports.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { registerEconomyAnalyticsRead } from "../../src/modules/admin/economy-analytics-definitions.js";
import { EconomyAnalyticsService } from "../../src/modules/admin/economy-analytics-service.js";
import { AdminService } from "../../src/modules/admin/service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const AS_OF = new Date("2026-09-02T12:00:00.000Z");

describe("EconomyAnalyticsService", () => {
  it("returns only bounded aggregate economy evidence using a server-owned clock", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "SYSTEM", id: null }));
    const readAggregate = vi.fn(async () => ({
      currencies: [
        {
          slug: "poke-dollar",
          displayName: "Poké Dollar",
          inflow: "1000",
          outflow: "400",
          netFlow: "600",
          totalBalance: "9000",
        },
      ],
      currenciesTruncated: false,
      inventory: {
        inflowUnits: "80",
        outflowUnits: "30",
        netFlowUnits: "50",
        totalUnitsHeld: "700",
      },
      walletProjectionMismatches: "2",
      inventoryProjectionMismatches: "1",
    }));
    const service = new EconomyAnalyticsService({ authorizeRead }, { readAggregate }, () => AS_OF);

    const result = await service.getAggregate({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: CORRELATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "economy.analytics.read",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(readAggregate).toHaveBeenCalledWith("staging", AS_OF);
    expect(result).toEqual({
      asOf: AS_OF.toISOString(),
      window: "30d",
      currencies: [
        {
          slug: "poke-dollar",
          displayName: "Poké Dollar",
          inflow: "1000",
          outflow: "400",
          netFlow: "600",
          totalBalance: "9000",
        },
      ],
      currenciesTruncated: false,
      inventory: {
        inflowUnits: "80",
        outflowUnits: "30",
        netFlowUnits: "50",
        totalUnitsHeld: "700",
      },
      anomalies: {
        walletProjectionMismatches: "2",
        inventoryProjectionMismatches: "1",
      },
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "playerId",
      "trainerName",
      "externalId",
      "correlationId",
      "ledgerId",
      "sourceId",
      "sourceType",
      "reason",
      "actorId",
      "events",
      "payload",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("denies a principal that has player.read but lacks economy.read", async () => {
    const registry = registerEconomyAnalyticsRead(new AdminOperationRegistry());
    const repository = {
      getAuthorizationSnapshot: vi.fn(async () => ({
        principalId: PRINCIPAL_ID,
        status: "ACTIVE" as const,
        capabilities: [{ key: "player.read", riskTier: 0 as const }],
        scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
      })),
    } as unknown as AdminOperationRepository;
    const readAggregate = vi.fn();
    const service = new EconomyAnalyticsService(
      new AdminService(registry, repository),
      { readAggregate },
      () => AS_OF,
    );

    await expect(
      service.getAggregate({
        principalId: PRINCIPAL_ID,
        environment: "staging",
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toMatchObject({ code: "ADMIN_AUTHORIZATION_DENIED" });
    expect(readAggregate).not.toHaveBeenCalled();
  });
});

describe("economy analytics registry definition", () => {
  it("is a zero-risk global READ guarded by economy.read", () => {
    const registry = registerEconomyAnalyticsRead(new AdminOperationRegistry());
    const definition = registry.require("economy.analytics.read");

    expect(definition.kind).toBe("READ");
    expect(definition.capabilityKey).toBe("economy.read");
    expect(definition.riskTier).toBe(0);
    expect(definition.authorizationMode).toBe("GLOBAL_ONLY");
    expect(definition.target({})).toEqual({ type: "SYSTEM", id: null });
    expect(definition.parseInput({})).toEqual({});
    expect(() => definition.parseInput({ window: "7d" })).toThrow();
    expect(() => definition.parseInput({ playerId: PRINCIPAL_ID })).toThrow();
    expect(definition.policy).toEqual({
      version: 1,
      requiresReason: false,
      requiresExpectedRevision: false,
      requiresSimulation: false,
      requiresConfirmation: false,
      requiredApprovals: 0,
    });
  });
});
