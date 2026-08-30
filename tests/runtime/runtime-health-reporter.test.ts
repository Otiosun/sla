import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppProviderConnectionState } from "../../src/adapters/whatsapp/adapter.js";
import {
  RuntimeHealthReporter,
  type RuntimeHealthWriter,
} from "../../src/runtime/runtime-health-reporter.js";

const instanceId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("RuntimeHealthReporter", () => {
  it("schedules heartbeats sequentially without overlapping a slow database write", async () => {
    vi.useFakeTimers();
    const first = deferred();
    let heartbeatCalls = 0;
    const writer: RuntimeHealthWriter = {
      markConnected: vi.fn(async () => {}),
      markDisconnected: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {
        heartbeatCalls += 1;
        if (heartbeatCalls === 1) await first.promise;
      }),
      stop: vi.fn(async () => {}),
    };
    const reporter = new RuntimeHealthReporter(writer, {
      instanceId,
      heartbeatMs: 1_000,
      onError: vi.fn(),
    });

    reporter.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writer.heartbeat).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(writer.heartbeat).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writer.heartbeat).toHaveBeenCalledTimes(2);

    await reporter.stop("STOPPED", "TEST_COMPLETE");
  });

  it("serializes provider transitions and terminal evidence", async () => {
    const calls: string[] = [];
    const writer: RuntimeHealthWriter = {
      async markConnected() {
        calls.push("CONNECTED");
      },
      async markDisconnected() {
        calls.push("DISCONNECTED");
      },
      async heartbeat() {
        calls.push("HEARTBEAT");
      },
      async stop(_instanceId, state, reason) {
        calls.push(`${state}:${reason}`);
      },
    };
    const reporter = new RuntimeHealthReporter(writer, {
      instanceId,
      heartbeatMs: 30_000,
      onError: vi.fn(),
    });

    const transitions: WhatsAppProviderConnectionState[] = ["CONNECTED", "DISCONNECTED"];
    for (const transition of transitions) await reporter.recordConnectionState(transition);
    await reporter.stop("INVALIDATED", "LOGGED_OUT");

    expect(calls).toEqual(["CONNECTED", "DISCONNECTED", "INVALIDATED:LOGGED_OUT"]);
  });

  it("reports heartbeat errors and schedules the next heartbeat instead of wedging health", async () => {
    vi.useFakeTimers();
    const onError = vi.fn((_error: unknown) => {});
    let attempts = 0;
    const writer: RuntimeHealthWriter = {
      markConnected: vi.fn(async () => {}),
      markDisconnected: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary database failure");
      }),
      stop: vi.fn(async () => {}),
    };
    const reporter = new RuntimeHealthReporter(writer, {
      instanceId,
      heartbeatMs: 1_000,
      onError,
    });

    reporter.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(writer.heartbeat).toHaveBeenCalledTimes(2);
    await reporter.stop("STOPPED", "TEST_COMPLETE");
  });
});
