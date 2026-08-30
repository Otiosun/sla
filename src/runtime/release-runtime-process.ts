import type { WhatsAppProviderConnectionState } from "../adapters/whatsapp/adapter.js";
import type { WhatsAppSessionInvalidationReason } from "./compose-whatsapp-runtime.js";
import type { RuntimeTerminalState } from "./postgres-runtime-health.js";
import { RuntimeTerminationController } from "./runtime-termination-controller.js";

export interface ReleaseRuntimeProcessHealth {
  start(): Promise<void>;
  recordConnectionState(state: WhatsAppProviderConnectionState): Promise<void>;
  stop(state: RuntimeTerminalState, reason: string): Promise<void>;
}

export interface ReleaseRuntimeProcessSupervisor {
  run(signal: AbortSignal): Promise<void>;
}

export class ReleaseRuntimeProcess {
  public constructor(
    private readonly health: ReleaseRuntimeProcessHealth,
    private readonly termination: RuntimeTerminationController,
  ) {}

  public readonly onProviderConnectionState = (
    state: WhatsAppProviderConnectionState,
  ): Promise<void> => this.health.recordConnectionState(state);

  public readonly onSessionInvalidated = (reason: WhatsAppSessionInvalidationReason): void => {
    this.termination.request("INVALIDATED", reason);
  };

  public readonly onHostSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    this.termination.request("STOPPED", signal);
  };

  public async run(supervisor: ReleaseRuntimeProcessSupervisor): Promise<void> {
    await this.health.start();
    try {
      await supervisor.run(this.termination.signal);
    } catch (error) {
      this.termination.recordFailure();
      throw error;
    } finally {
      const termination = this.termination.termination ?? {
        state: "STOPPED" as const,
        reason: "RUNTIME_COMPLETED",
      };
      await this.health.stop(termination.state, termination.reason);
    }
  }
}
