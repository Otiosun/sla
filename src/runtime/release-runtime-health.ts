import type { WhatsAppProviderConnectionState } from "../adapters/whatsapp/adapter.js";
import type {
  RuntimeInstanceRegistration,
  RuntimeTerminalState,
} from "./postgres-runtime-health.js";
import {
  RuntimeHealthReporter,
  type RuntimeHealthWriter,
} from "./runtime-health-reporter.js";

export interface ReleaseRuntimeHealthStore extends RuntimeHealthWriter {
  register(input: RuntimeInstanceRegistration): Promise<void>;
}

export interface ReleaseRuntimeHealthOptions {
  readonly registration: RuntimeInstanceRegistration;
  readonly heartbeatMs: number;
  readonly onError: (error: unknown) => void;
}

export class ReleaseRuntimeHealth {
  private readonly store: ReleaseRuntimeHealthStore;
  private readonly registration: RuntimeInstanceRegistration;
  private readonly reporter: RuntimeHealthReporter;
  private started = false;
  private stopped = false;

  public constructor(store: ReleaseRuntimeHealthStore, options: ReleaseRuntimeHealthOptions) {
    this.store = store;
    this.registration = options.registration;
    this.reporter = new RuntimeHealthReporter(store, {
      instanceId: options.registration.instanceId,
      heartbeatMs: options.heartbeatMs,
      onError: options.onError,
    });
  }

  public async start(): Promise<void> {
    if (this.started) throw new Error("release runtime health has already started");
    await this.store.register(this.registration);
    this.started = true;
    this.reporter.start();
  }

  public recordConnectionState(state: WhatsAppProviderConnectionState): Promise<void> {
    if (!this.started || this.stopped) {
      return Promise.reject(new Error("release runtime health has not started"));
    }
    return this.reporter.recordConnectionState(state);
  }

  public async stop(state: RuntimeTerminalState, reason: string): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    await this.reporter.stop(state, reason);
  }
}
