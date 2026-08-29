import { type MetricLabels, type MetricSink, monotonicNowMs, NOOP_METRICS } from "./index.js";

export interface ResultLike {
  readonly ok: boolean;
}

export interface AsyncResultOperation<TInput, TResult extends ResultLike> {
  execute(input: TInput): Promise<TResult>;
}

export class ObservedAsyncResultOperation<TInput, TResult extends ResultLike> {
  constructor(
    private readonly operation: AsyncResultOperation<TInput, TResult>,
    private readonly metrics: MetricSink = NOOP_METRICS,
    private readonly labels: MetricLabels = {},
  ) {}

  async execute(input: TInput): Promise<TResult> {
    const startedAtMs = monotonicNowMs();
    let result: "success" | "error" = "success";
    try {
      const output = await this.operation.execute(input);
      if (!output.ok) {
        result = "error";
        this.metrics.increment("runtime.operation.errors_total", 1, this.labels);
      }
      return output;
    } catch (error) {
      result = "error";
      this.metrics.increment("runtime.operation.errors_total", 1, this.labels);
      throw error;
    } finally {
      this.metrics.observe("runtime.operation.duration_ms", monotonicNowMs() - startedAtMs, {
        ...this.labels,
        result,
      });
    }
  }
}

export interface QueueRunResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
}

export interface QueueRunner {
  runOnce(): Promise<QueueRunResult>;
}

export class ObservedQueueRunner implements QueueRunner {
  constructor(
    private readonly runner: QueueRunner,
    private readonly queue: string,
    private readonly metrics: MetricSink = NOOP_METRICS,
  ) {}

  async runOnce(): Promise<QueueRunResult> {
    const startedAtMs = monotonicNowMs();
    let failedRun = false;
    try {
      const output = await this.runner.runOnce();
      this.metrics.gauge("messaging.queue.claimed", output.claimed, { queue: this.queue });
      if (output.sent > 0) {
        this.metrics.increment("messaging.queue.sent_total", output.sent, { queue: this.queue });
      }
      if (output.failed > 0) {
        this.metrics.increment("messaging.queue.failed_total", output.failed, {
          queue: this.queue,
        });
      }
      return output;
    } catch (error) {
      failedRun = true;
      this.metrics.increment("messaging.queue.failed_total", 1, {
        queue: this.queue,
        scope: "runner",
      });
      throw error;
    } finally {
      this.metrics.observe("messaging.queue.run_duration_ms", monotonicNowMs() - startedAtMs, {
        queue: this.queue,
        result: failedRun ? "error" : "success",
      });
    }
  }
}
