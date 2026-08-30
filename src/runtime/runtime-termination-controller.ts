import type { RuntimeTerminalState } from "./postgres-runtime-health.js";

export interface RuntimeTermination {
  readonly state: RuntimeTerminalState;
  readonly reason: string;
}

export class RuntimeTerminationController {
  private readonly abortController = new AbortController();
  private current: RuntimeTermination | null = null;

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public get termination(): RuntimeTermination | null {
    return this.current;
  }

  public request(state: RuntimeTerminalState, reason: string): void {
    if (this.current !== null) return;
    this.current = { state, reason };
    this.abortController.abort();
  }

  public recordFailure(): void {
    if (this.current !== null) return;
    this.current = { state: "STOPPED", reason: "RUNTIME_FAILURE" };
  }
}
