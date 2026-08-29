export type MetricName =
  | "runtime.operation.duration_ms"
  | "runtime.operation.errors_total"
  | "messaging.queue.claimed"
  | "messaging.queue.sent_total"
  | "messaging.queue.failed_total"
  | "messaging.queue.run_duration_ms"
  | "db.transaction.duration_ms"
  | "db.transaction.attempts"
  | "db.transaction.errors_total"
  | "db.transaction.retries_total"
  | "whatsapp.connection.open_total"
  | "whatsapp.connection.close_total"
  | "whatsapp.connection.logged_out_total"
  | "whatsapp.reconnect.scheduled_total"
  | "whatsapp.incoming.total"
  | "whatsapp.incoming.errors_total"
  | "whatsapp.outgoing.total"
  | "whatsapp.outgoing.errors_total"
  | "whatsapp.outgoing.duration_ms";

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricSink {
  increment(name: MetricName, value?: number, labels?: MetricLabels): void;
  observe(name: MetricName, value: number, labels?: MetricLabels): void;
  gauge(name: MetricName, value: number, labels?: MetricLabels): void;
}

function assertMetricValue(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Metric values must be finite and non-negative");
  }
}

function stableLabels(labels: MetricLabels | undefined): MetricLabels {
  if (labels === undefined) return {};
  return Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

export class NoopMetricSink implements MetricSink {
  increment(_name: MetricName, _value = 1, _labels: MetricLabels = {}): void {}
  observe(_name: MetricName, _value: number, _labels: MetricLabels = {}): void {}
  gauge(_name: MetricName, _value: number, _labels: MetricLabels = {}): void {}
}

export const NOOP_METRICS: MetricSink = new NoopMetricSink();

export interface MetricSample {
  readonly kind: "counter" | "histogram" | "gauge";
  readonly name: MetricName;
  readonly value: number;
  readonly labels: MetricLabels;
}

export class InMemoryMetricSink implements MetricSink {
  readonly samples: MetricSample[] = [];

  increment(name: MetricName, value = 1, labels: MetricLabels = {}): void {
    assertMetricValue(value);
    this.samples.push({ kind: "counter", name, value, labels: stableLabels(labels) });
  }

  observe(name: MetricName, value: number, labels: MetricLabels = {}): void {
    assertMetricValue(value);
    this.samples.push({ kind: "histogram", name, value, labels: stableLabels(labels) });
  }

  gauge(name: MetricName, value: number, labels: MetricLabels = {}): void {
    assertMetricValue(value);
    this.samples.push({ kind: "gauge", name, value, labels: stableLabels(labels) });
  }
}

export interface JsonMetricLine {
  readonly type: "metric";
  readonly timestamp: string;
  readonly kind: MetricSample["kind"];
  readonly name: MetricName;
  readonly value: number;
  readonly labels: MetricLabels;
}

export class JsonLineMetricSink implements MetricSink {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly now: () => Date = () => new Date(),
  ) {}

  increment(name: MetricName, value = 1, labels: MetricLabels = {}): void {
    this.emit("counter", name, value, labels);
  }

  observe(name: MetricName, value: number, labels: MetricLabels = {}): void {
    this.emit("histogram", name, value, labels);
  }

  gauge(name: MetricName, value: number, labels: MetricLabels = {}): void {
    this.emit("gauge", name, value, labels);
  }

  private emit(
    kind: MetricSample["kind"],
    name: MetricName,
    value: number,
    labels: MetricLabels,
  ): void {
    assertMetricValue(value);
    const line: JsonMetricLine = {
      type: "metric",
      timestamp: this.now().toISOString(),
      kind,
      name,
      value,
      labels: stableLabels(labels),
    };
    this.write(JSON.stringify(line));
  }
}

export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}
