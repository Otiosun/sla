import { describe, expect, it, vi } from "vitest";
import type { RuntimeInstanceRegistration } from "../../src/runtime/postgres-runtime-health.js";
import {
  ReleaseRuntimeHealth,
  type ReleaseRuntimeHealthStore,
} from "../../src/runtime/release-runtime-health.js";

const registration: RuntimeInstanceRegistration = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  environment: "staging",
  deploymentRevision: "1234567890abcdef1234567890abcdef12345678",
  whatsappSessionKey: "staging-main",
};

function store(overrides: Partial<ReleaseRuntimeHealthStore> = {}): ReleaseRuntimeHealthStore {
  return {
    register: vi.fn(async () => {}),
    markConnected: vi.fn(async () => {}),
    markDisconnected: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ReleaseRuntimeHealth", () => {
  it("registers the exact release identity before accepting provider state", async () => {
    const healthStore = store();
    const health = new ReleaseRuntimeHealth(healthStore, {
      registration,
      heartbeatMs: 30_000,
      onError: vi.fn(),
    });

    await health.start();
    expect(healthStore.register).toHaveBeenCalledWith(registration);

    await health.recordConnectionState("CONNECTED");
    expect(healthStore.markConnected).toHaveBeenCalledWith(registration.instanceId);

    await health.stop("STOPPED", "SIGTERM");
    expect(healthStore.stop).toHaveBeenCalledWith(registration.instanceId, "STOPPED", "SIGTERM");
  });

  it("fails startup closed when durable registration cannot be written", async () => {
    const healthStore = store({
      register: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const health = new ReleaseRuntimeHealth(healthStore, {
      registration,
      heartbeatMs: 30_000,
      onError: vi.fn(),
    });

    await expect(health.start()).rejects.toThrow("database unavailable");
    await expect(health.recordConnectionState("CONNECTED")).rejects.toThrow(
      "release runtime health has not started",
    );
    expect(healthStore.markConnected).not.toHaveBeenCalled();
  });

  it("persists invalidation as a terminal state without rewriting history", async () => {
    const healthStore = store();
    const health = new ReleaseRuntimeHealth(healthStore, {
      registration,
      heartbeatMs: 30_000,
      onError: vi.fn(),
    });

    await health.start();
    await health.stop("INVALIDATED", "LOGGED_OUT");
    await health.stop("INVALIDATED", "LOGGED_OUT");

    expect(healthStore.stop).toHaveBeenCalledTimes(1);
    expect(healthStore.stop).toHaveBeenCalledWith(
      registration.instanceId,
      "INVALIDATED",
      "LOGGED_OUT",
    );
  });
});
