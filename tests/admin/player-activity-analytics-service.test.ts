import { describe, expect, it, vi } from "vitest";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { registerPlayerActivityAnalyticsRead } from "../../src/modules/admin/player-activity-analytics-definitions.js";
import { PlayerActivityAnalyticsService } from "../../src/modules/admin/player-activity-analytics-service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const AS_OF = new Date("2026-09-01T12:00:00.000Z");

describe("PlayerActivityAnalyticsService", () => {
  it("returns only aggregate activity and return counts using a server-owned clock", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "SYSTEM", id: null }));
    const readAggregate = vi.fn(async () => ({
      last24Hours: 3,
      last7Days: 8,
      last30Days: 21,
      returningPlayers7Days: 5,
    }));
    const service = new PlayerActivityAnalyticsService(
      { authorizeRead },
      { readAggregate },
      () => AS_OF,
    );

    const result = await service.getAggregate({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: CORRELATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "player.activity.read",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(readAggregate).toHaveBeenCalledWith("staging", AS_OF);
    expect(result).toEqual({
      asOf: "2026-09-01T12:00:00.000Z",
      activePlayers: {
        last24Hours: 3,
        last7Days: 8,
        last30Days: 21,
      },
      returningPlayers7Days: 5,
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "playerId",
      "trainerName",
      "externalId",
      "correlationId",
      "operationId",
      "payload",
      "metadata",
      "reason",
      "events",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("player activity analytics Registry definition", () => {
  it("is a zero-risk global READ reusing player.read authority", () => {
    const registry = registerPlayerActivityAnalyticsRead(new AdminOperationRegistry());
    const definition = registry.require("player.activity.read");

    expect(definition.kind).toBe("READ");
    expect(definition.capabilityKey).toBe("player.read");
    expect(definition.riskTier).toBe(0);
    expect(definition.authorizationMode).toBe("GLOBAL_ONLY");
    expect(definition.target({})).toEqual({ type: "SYSTEM", id: null });
    expect(definition.parseInput({})).toEqual({});
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
