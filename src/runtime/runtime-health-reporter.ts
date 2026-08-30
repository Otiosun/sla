import type { WhatsAppProviderConnectionState } from "../adapters/whatsapp/adapter.js";
import type { RuntimeTerminalState } from "./postgres-runtime-health.js";

export interface RuntimeHealthWriter {
  markConnected(instanceId: string): Promise<void>;
  markDisconnected(instanceId: string): Promise<void>;
  heartbeat(instanceId: string): Promise<void>;
  stop(instanceId: string, state: RuntimeTerminalState, reason: string): Promise<void>;
}

export interface RuntimeHealthReporterOptions {
  readonly instanceId: string;
  readonly heartbeatMs: number;
  readonly onError: (error: unknown) => void;
}

export class RuntimeHealthReporter {
  private readonly writer: RuntimeHealthWriter;
  private readonly instanceId: string;
  private readonly heartbeatMs: number;
  private readonly onError: (error: unknown) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  public constructor(writer: RuntimeHealthWriter, options: RuntimeHealthReporterOptions) {
    if (!Number.isSafeInteger(options.heartbeatMs) || options.heartbeatMs <= 0) {
      throw new Error("runtime health heartbeatMs must be a positive safe integer");
    }
    this.writer = writer;
    this.instanceId = options.instanceId;
    this.heartbeatMs = options.heartbeatMs;
    this.onError = options.onError;
  }

  public start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.scheduleHeartbeat();
  }

  public recordConnectionState(state: WhatsAppProviderConnectionState): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.enqueue(() =>
      state === "CONNECTED"
        ? this.writer.markConnected(this.instanceId)
        : this.writer.markDisconnected(this.instanceId),
    );
  }

  public async stop(state: RuntimeTerminalState, reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.tail;
    await this.writer.stop(this.instanceId, state, reason);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }

  private scheduleHeartbeat(): void {
    if (this.stopped || !this.started || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runHeartbeat();
    }, this.heartbeatMs);
  }

  private async runHeartbeat(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.enqueue(() => this.writer.heartbeat(this.instanceId));
    } catch (error) {
      this.onError(error);
    } finally {
      this.scheduleHeartbeat();
    }
  }
}
