import { describe, expect, it, vi } from "vitest";
import type { WhatsAppProviderConnectionState } from "../../src/adapters/whatsapp/adapter.js";
import {
  ReleaseRuntimeProcess,
  type ReleaseRuntimeProcessHealth,
  type ReleaseRuntimeProcessSupervisor,
} from "../../src/runtime/release-runtime-process.js";
import { RuntimeTerminationController } from "../../src/runtime/runtime-termination-controller.js";

function health(events: string[]): ReleaseRuntimeProcessHealth {
  return {
    start: vi.fn(async () => {
      events.push("health.start");
    }),
    recordConnectionState: vi.fn(async (state: WhatsAppProviderConnectionState) => {
      events.push(`provider.${state}`);
    }),
    stop: vi.fn(async (state, reason) => {
      events.push(`health.stop.${state}.${reason}`);
    }),
  };
}

function supervisor(events: string[]): ReleaseRuntimeProcessSupervisor {
  return {
    run: vi.fn(async () => {
      events.push("supervisor.run");
    }),
  };
}

describe("ReleaseRuntimeProcess", () => {
  it("registers durable health before the WhatsApp supervisor can start", async () => {
    const events: string[] = [];
    const runtimeHealth = health(events);
    const termination = new RuntimeTerminationController();
    termination.request("STOPPED", "SIGTERM");
    const process = new ReleaseRuntimeProcess(runtimeHealth, termination);

    await process.run(supervisor(events));

    expect(events).toEqual([
      "health.start",
      "supervisor.run",
      "health.stop.STOPPED.SIGTERM",
    ]);
  });

  it("routes provider state into durable release health", async () => {
    const events: string[] = [];
    const runtimeHealth = health(events);
    const process = new ReleaseRuntimeProcess(runtimeHealth, new RuntimeTerminationController());

    await process.onProviderConnectionState("CONNECTED");
    await process.onProviderConnectionState("DISCONNECTED");

    expect(runtimeHealth.recordConnectionState).toHaveBeenNthCalledWith(1, "CONNECTED");
    expect(runtimeHealth.recordConnectionState).toHaveBeenNthCalledWith(2, "DISCONNECTED");
  });

  it("preserves session invalidation when host shutdown follows it", async () => {
    const events: string[] = [];
    const runtimeHealth = health(events);
    const termination = new RuntimeTerminationController();
    const process = new ReleaseRuntimeProcess(runtimeHealth, termination);

    process.onSessionInvalidated("LOGGED_OUT");
    process.onHostSignal("SIGTERM");
    await process.run(supervisor(events));

    expect(termination.termination).toEqual({ state: "INVALIDATED", reason: "LOGGED_OUT" });
    expect(events.at(-1)).toBe("health.stop.INVALIDATED.LOGGED_OUT");
  });

  it("records unexpected supervisor failures and still closes durable health", async () => {
    const events: string[] = [];
    const runtimeHealth = health(events);
    const termination = new RuntimeTerminationController();
    const process = new ReleaseRuntimeProcess(runtimeHealth, termination);
    const failingSupervisor: ReleaseRuntimeProcessSupervisor = {
      run: vi.fn(async () => {
        events.push("supervisor.run");
        throw new Error("boom");
      }),
    };

    await expect(process.run(failingSupervisor)).rejects.toThrow("boom");

    expect(termination.termination).toEqual({ state: "STOPPED", reason: "RUNTIME_FAILURE" });
    expect(events.at(-1)).toBe("health.stop.STOPPED.RUNTIME_FAILURE");
  });
});
