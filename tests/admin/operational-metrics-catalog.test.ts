import { describe, expect, it } from "vitest";
import {
  OPERATIONAL_METRICS_CATALOG,
  OPERATIONAL_METRICS_CATALOG_VERSION,
} from "../../src/modules/admin/operational-metrics-catalog.js";

const SAFE_DIMENSIONS = new Set([
  "operationType",
  "riskTier",
  "queue",
  "status",
  "incidentSource",
  "incidentState",
  "runtimeState",
]);

const FORBIDDEN_DIMENSIONS = [
  "principalId",
  "playerId",
  "targetId",
  "correlationId",
  "messageId",
  "phone",
  "whatsapp",
  "reason",
  "payload",
  "metadata",
];

describe("F8.1 operational metrics catalog", () => {
  it("defines only actionable operations/runtime/messaging/incident metrics", () => {
    expect(OPERATIONAL_METRICS_CATALOG_VERSION).toBe(1);
    expect(OPERATIONAL_METRICS_CATALOG.map((metric) => metric.key)).toEqual([
      "admin_operation_failure_count",
      "admin_operation_failure_rate",
      "messaging_inbox_backlog",
      "messaging_inbox_failure_count",
      "messaging_outbox_backlog",
      "messaging_outbox_failure_count",
      "messaging_outbox_dead_count",
      "runtime_heartbeat_age_seconds",
      "incident_signal_count",
    ]);

    for (const metric of OPERATIONAL_METRICS_CATALOG) {
      expect(metric.operationalQuestion.length).toBeGreaterThan(0);
      expect(metric.operatorAction.length).toBeGreaterThan(0);
      expect(metric.source.length).toBeGreaterThan(0);
      expect(["count", "ratio", "seconds"]).toContain(metric.unit);
      expect(["instant", "5m", "15m", "1h"]).toContain(metric.window);
      expect(metric.dimensions.every((dimension) => SAFE_DIMENSIONS.has(dimension))).toBe(true);
    }
  });

  it("excludes vanity, high-cardinality, PII and future-slice dimensions", () => {
    const serialized = JSON.stringify(OPERATIONAL_METRICS_CATALOG);

    for (const forbidden of FORBIDDEN_DIMENSIONS) {
      expect(serialized).not.toContain(forbidden);
    }

    for (const outOfScope of [
      "active_players",
      "dau",
      "mau",
      "retention",
      "revenue",
      "wallet",
      "economy",
      "content_publish",
      "content_usage",
      "alertThreshold",
      "threshold",
    ]) {
      expect(serialized).not.toContain(outOfScope);
    }
  });

  it("keeps every dimension low-cardinality and explicitly allowlisted", () => {
    const dimensions = new Set(OPERATIONAL_METRICS_CATALOG.flatMap((metric) => metric.dimensions));
    expect([...dimensions].sort()).toEqual([...SAFE_DIMENSIONS].sort());
  });
});
