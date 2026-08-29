export type AlertSeverity = "WARNING" | "CRITICAL";

export interface OperationalSnapshot {
  readonly runtimeP95LatencyMs: number;
  readonly runtimeErrorRatio: number;
  readonly queueOldestAgeMs: number;
  readonly databaseErrorRatio: number;
  readonly whatsappDisconnectedMs: number;
  readonly backupAgeMs: number;
  readonly backupLastRunSucceeded: boolean;
}

export interface AlertSignal {
  readonly key:
    | "runtime.latency"
    | "runtime.error_ratio"
    | "messaging.queue_age"
    | "database.error_ratio"
    | "whatsapp.disconnected"
    | "backup.failed"
    | "backup.stale";
  readonly severity: AlertSeverity;
  readonly observed: number;
  readonly threshold: number;
}

export interface AlertThresholds {
  readonly runtimeP95LatencyWarningMs: number;
  readonly runtimeP95LatencyCriticalMs: number;
  readonly runtimeErrorRatioWarning: number;
  readonly runtimeErrorRatioCritical: number;
  readonly queueOldestAgeWarningMs: number;
  readonly queueOldestAgeCriticalMs: number;
  readonly databaseErrorRatioWarning: number;
  readonly databaseErrorRatioCritical: number;
  readonly whatsappDisconnectedWarningMs: number;
  readonly whatsappDisconnectedCriticalMs: number;
  readonly backupAgeWarningMs: number;
  readonly backupAgeCriticalMs: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  runtimeP95LatencyWarningMs: 1_500,
  runtimeP95LatencyCriticalMs: 3_000,
  runtimeErrorRatioWarning: 0.02,
  runtimeErrorRatioCritical: 0.05,
  queueOldestAgeWarningMs: 60_000,
  queueOldestAgeCriticalMs: 300_000,
  databaseErrorRatioWarning: 0.01,
  databaseErrorRatioCritical: 0.02,
  whatsappDisconnectedWarningMs: 60_000,
  whatsappDisconnectedCriticalMs: 300_000,
  backupAgeWarningMs: 26 * 60 * 60 * 1_000,
  backupAgeCriticalMs: 36 * 60 * 60 * 1_000,
};

function assertRatio(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite ratio between 0 and 1`);
  }
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
}

function thresholdSignal(input: {
  readonly key: AlertSignal["key"];
  readonly observed: number;
  readonly warning: number;
  readonly critical: number;
}): AlertSignal | null {
  if (input.observed >= input.critical) {
    return {
      key: input.key,
      severity: "CRITICAL",
      observed: input.observed,
      threshold: input.critical,
    };
  }
  if (input.observed >= input.warning) {
    return {
      key: input.key,
      severity: "WARNING",
      observed: input.observed,
      threshold: input.warning,
    };
  }
  return null;
}

export function evaluateOperationalAlerts(
  snapshot: OperationalSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): readonly AlertSignal[] {
  assertNonNegative("runtimeP95LatencyMs", snapshot.runtimeP95LatencyMs);
  assertRatio("runtimeErrorRatio", snapshot.runtimeErrorRatio);
  assertNonNegative("queueOldestAgeMs", snapshot.queueOldestAgeMs);
  assertRatio("databaseErrorRatio", snapshot.databaseErrorRatio);
  assertNonNegative("whatsappDisconnectedMs", snapshot.whatsappDisconnectedMs);
  assertNonNegative("backupAgeMs", snapshot.backupAgeMs);

  const signals: AlertSignal[] = [];
  const candidates = [
    thresholdSignal({
      key: "runtime.latency",
      observed: snapshot.runtimeP95LatencyMs,
      warning: thresholds.runtimeP95LatencyWarningMs,
      critical: thresholds.runtimeP95LatencyCriticalMs,
    }),
    thresholdSignal({
      key: "runtime.error_ratio",
      observed: snapshot.runtimeErrorRatio,
      warning: thresholds.runtimeErrorRatioWarning,
      critical: thresholds.runtimeErrorRatioCritical,
    }),
    thresholdSignal({
      key: "messaging.queue_age",
      observed: snapshot.queueOldestAgeMs,
      warning: thresholds.queueOldestAgeWarningMs,
      critical: thresholds.queueOldestAgeCriticalMs,
    }),
    thresholdSignal({
      key: "database.error_ratio",
      observed: snapshot.databaseErrorRatio,
      warning: thresholds.databaseErrorRatioWarning,
      critical: thresholds.databaseErrorRatioCritical,
    }),
    thresholdSignal({
      key: "whatsapp.disconnected",
      observed: snapshot.whatsappDisconnectedMs,
      warning: thresholds.whatsappDisconnectedWarningMs,
      critical: thresholds.whatsappDisconnectedCriticalMs,
    }),
    thresholdSignal({
      key: "backup.stale",
      observed: snapshot.backupAgeMs,
      warning: thresholds.backupAgeWarningMs,
      critical: thresholds.backupAgeCriticalMs,
    }),
  ];

  for (const signal of candidates) {
    if (signal !== null) signals.push(signal);
  }

  if (!snapshot.backupLastRunSucceeded) {
    signals.push({
      key: "backup.failed",
      severity: "CRITICAL",
      observed: 1,
      threshold: 1,
    });
  }

  return signals;
}
