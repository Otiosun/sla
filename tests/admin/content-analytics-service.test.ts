import { describe, expect, it, vi } from "vitest";
import type { AdminOperationRepository } from "../../src/modules/admin/ports.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { registerContentAnalyticsRead } from "../../src/modules/admin/content-analytics-definitions.js";
import { ContentAnalyticsService } from "../../src/modules/admin/content-analytics-service.js";
import { AdminService } from "../../src/modules/admin/service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const AS_OF = new Date("2026-09-03T12:00:00.000Z");

describe("ContentAnalyticsService", () => {
  it("returns only bounded aggregate gameplay evidence using a server-owned clock", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "SYSTEM", id: null }));
    const readAggregate = vi.fn(async () => ({
      encounters: {
        created: "12",
        closed: "9",
      },
      captures: {
        attemptsCreated: "8",
        captured: "5",
        failed: "2",
      },
      progression: {
        xpAwards: "22",
        xpAwarded: "12500",
        evolutions: "3",
      },
    }));
    const service = new ContentAnalyticsService({ authorizeRead }, { readAggregate }, () => AS_OF);

    const result = await service.getAggregate({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: CORRELATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "content.analytics.read",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(readAggregate).toHaveBeenCalledWith("staging", AS_OF);
    expect(result).toEqual({
      asOf: AS_OF.toISOString(),
      window: "30d",
      encounters: {
        created: "12",
        closed: "9",
      },
      captures: {
        attemptsCreated: "8",
        captured: "5",
        failed: "2",
      },
      progression: {
        xpAwards: "22",
        xpAwarded: "12500",
        evolutions: "3",
      },
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "playerId",
      "trainerName",
      "externalId",
      "correlationId",
      "encounterId",
      "captureAttemptId",
      "pokemonInstanceId",
      "sourceId",
      "sourceType",
      "reason",
      "actorId",
      "events",
      "payload",
      "result",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("denies a principal that has world.read but lacks content.analytics.read", async () => {
    const registry = registerContentAnalyticsRead(new AdminOperationRegistry());
    const repository = {
      getAuthorizationSnapshot: vi.fn(async () => ({
        principalId: PRINCIPAL_ID,
        status: "ACTIVE" as const,
        capabilities: [{ key: "world.read", riskTier: 0 as const }],
        scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
      })),
    } as unknown as AdminOperationRepository;
    const readAggregate = vi.fn();
    const service = new ContentAnalyticsService(
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

describe("content analytics registry definition", () => {
  it("is a zero-risk global READ guarded by a dedicated aggregate capability", () => {
    const registry = registerContentAnalyticsRead(new AdminOperationRegistry());
    const definition = registry.require("content.analytics.read");

    expect(definition.kind).toBe("READ");
    expect(definition.capabilityKey).toBe("content.analytics.read");
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
