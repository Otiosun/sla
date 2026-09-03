import { describe, expect, it, vi } from "vitest";
import { registerGameplayAnalyticsRead } from "../../src/modules/admin/gameplay-analytics-definitions.js";
import { GameplayAnalyticsService } from "../../src/modules/admin/gameplay-analytics-service.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import type { AdminOperationRepository } from "../../src/modules/admin/ports.js";
import { AdminService } from "../../src/modules/admin/service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const AS_OF = new Date("2026-09-02T12:00:00.000Z");

const visibleWindow = {
  encounters: {
    suppressed: false as const,
    created: "12",
    closed: "10",
    captured: "4",
    fled: "3",
    expired: "2",
    closedOther: "1",
  },
  captures: {
    suppressed: false as const,
    resolved: "9",
    captured: "4",
    failed: "5",
  },
  trainerProgression: {
    suppressed: false as const,
    adjustments: "7",
    pointsAdded: "120",
    pointsRemoved: "20",
    netPoints: "100",
  },
};

const suppressedWindow = {
  encounters: { suppressed: true as const },
  captures: { suppressed: true as const },
  trainerProgression: { suppressed: true as const },
};

describe("GameplayAnalyticsService", () => {
  it("returns only bounded aggregate gameplay evidence on fixed server-owned windows", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "SYSTEM", id: null }));
    const readAggregate = vi.fn(async () => ({
      windows: [
        { window: "24h" as const, ...visibleWindow },
        { window: "7d" as const, ...visibleWindow },
        { window: "30d" as const, ...suppressedWindow },
      ],
    }));
    const service = new GameplayAnalyticsService({ authorizeRead }, { readAggregate }, () => AS_OF);

    const result = await service.getAggregate({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: CORRELATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "gameplay.analytics.read",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(readAggregate).toHaveBeenCalledWith("staging", AS_OF);
    expect(result).toEqual({
      asOf: AS_OF.toISOString(),
      windows: [
        { window: "24h", ...visibleWindow },
        { window: "7d", ...visibleWindow },
        { window: "30d", ...suppressedWindow },
      ],
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "playerId",
      "trainerName",
      "externalId",
      "correlationId",
      "encounterId",
      "captureAttemptId",
      "ledgerId",
      "sourceId",
      "sourceType",
      "reason",
      "payload",
      "metadata",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("denies principals without world.read even if they can read players and progression", async () => {
    const registry = registerGameplayAnalyticsRead(new AdminOperationRegistry());
    const repository = {
      getAuthorizationSnapshot: vi.fn(async () => ({
        principalId: PRINCIPAL_ID,
        status: "ACTIVE" as const,
        capabilities: [
          { key: "player.read", riskTier: 0 as const },
          { key: "progression.read", riskTier: 0 as const },
        ],
        scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
      })),
    } as unknown as AdminOperationRepository;
    const readAggregate = vi.fn();
    const service = new GameplayAnalyticsService(
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

describe("gameplay analytics registry definition", () => {
  it("is a zero-risk global READ using world.read authority", () => {
    const registry = registerGameplayAnalyticsRead(new AdminOperationRegistry());
    const definition = registry.require("gameplay.analytics.read");

    expect(definition.kind).toBe("READ");
    expect(definition.capabilityKey).toBe("world.read");
    expect(definition.riskTier).toBe(0);
    expect(definition.authorizationMode).toBe("GLOBAL_ONLY");
    expect(definition.target({})).toEqual({ type: "SYSTEM", id: null });
    expect(definition.parseInput({})).toEqual({});
    expect(() => definition.parseInput({ window: "7d" })).toThrow();
    expect(() => definition.parseInput({ playerId: PRINCIPAL_ID })).toThrow();
  });
});
