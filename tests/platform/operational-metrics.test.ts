import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateOperationalAlerts,
} from "../../src/platform/metrics/alerts.js";
import {
  ObservedAsyncResultOperation,
  ObservedQueueRunner,
} from "../../src/platform/metrics/instrumentation.js";
import { InMemoryMetricSink, JsonLineMetricSink } from "../../src/platform/metrics/index.js";

describe("operational metrics", () => {
  it("emits stable JSON metric lines without implicit application context", () => {
    const lines: string[] = [];
    const metrics = new JsonLineMetricSink(
      (line) => lines.push(line),
      () => new Date("2026-08-29T12:00:00.000Z"),
    );

    metrics.increment("runtime.operation.errors_total", 1, {
      operation: "message",
      result: "error",
    });

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      type: "metric",
      timestamp: "2026-08-29T12:00:00.000Z",
      kind: "counter",
      name: "runtime.operation.errors_total",
      value: 1,
      labels: { operation: "message", result: "error" },
    });
  });

  it("rejects invalid metric values before they reach a sink", () => {
    const metrics = new InMemoryMetricSink();
    expect(() => metrics.increment("messaging.queue.failed_total", -1)).toThrow(RangeError);
    expect(() => metrics.observe("db.transaction.duration_ms", Number.NaN)).toThrow(RangeError);
  });

  it("observes result latency and application errors through a generic boundary", async () => {
    const metrics = new InMemoryMetricSink();
    const operation = new ObservedAsyncResultOperation(
      { execute: async () => ({ ok: false as const }) },
      metrics,
      { operation: "messaging.receive" },
    );

    await expect(operation.execute({})).resolves.toEqual({ ok: false });
    expect(metrics.samples.some((sample) => sample.name === "runtime.operation.errors_total")).toBe(
      true,
    );
    expect(metrics.samples.some((sample) => sample.name === "runtime.operation.duration_ms")).toBe(
      true,
    );
  });

  it("exports queue throughput, failures and run latency from the real worker shape", async () => {
    const metrics = new InMemoryMetricSink();
    const runner = new ObservedQueueRunner(
      { runOnce: async () => ({ claimed: 5, sent: 4, failed: 1 }) },
      "outbox",
      metrics,
    );

    await expect(runner.runOnce()).resolves.toEqual({ claimed: 5, sent: 4, failed: 1 });
    expect(metrics.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "gauge", name: "messaging.queue.claimed", value: 5 }),
        expect.objectContaining({ name: "messaging.queue.sent_total", value: 4 }),
        expect.objectContaining({ name: "messaging.queue.failed_total", value: 1 }),
        expect.objectContaining({ name: "messaging.queue.run_duration_ms" }),
      ]),
    );
  });
});

describe("operational alert thresholds", () => {
  const healthy = {
    runtimeP95LatencyMs: 100,
    runtimeErrorRatio: 0,
    queueOldestAgeMs: 0,
    databaseErrorRatio: 0,
    whatsappDisconnectedMs: 0,
    backupAgeMs: 60_000,
    backupLastRunSucceeded: true,
  } as const;

  it("is silent for a healthy snapshot", () => {
    expect(evaluateOperationalAlerts(healthy)).toEqual([]);
  });

  it("raises warning at the threshold and critical at the critical threshold", () => {
    const warning = evaluateOperationalAlerts({
      ...healthy,
      runtimeP95LatencyMs: DEFAULT_ALERT_THRESHOLDS.runtimeP95LatencyWarningMs,
    });
    expect(warning).toContainEqual(
      expect.objectContaining({ key: "runtime.latency", severity: "WARNING" }),
    );

    const critical = evaluateOperationalAlerts({
      ...healthy,
      runtimeP95LatencyMs: DEFAULT_ALERT_THRESHOLDS.runtimeP95LatencyCriticalMs,
    });
    expect(critical).toContainEqual(
      expect.objectContaining({ key: "runtime.latency", severity: "CRITICAL" }),
    );
  });

  it("treats a failed backup as critical independently of backup age", () => {
    expect(evaluateOperationalAlerts({ ...healthy, backupLastRunSucceeded: false })).toContainEqual(
      expect.objectContaining({ key: "backup.failed", severity: "CRITICAL" }),
    );
  });

  it("fails closed on malformed ratios instead of silently normalizing them", () => {
    expect(() => evaluateOperationalAlerts({ ...healthy, runtimeErrorRatio: 1.1 })).toThrow(
      RangeError,
    );
  });
});
