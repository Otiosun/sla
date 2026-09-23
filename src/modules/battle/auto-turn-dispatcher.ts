import type { PvpTurnResolutionResult } from "./pvp-turn-resolution.js";

export interface AutoTurnBatchInput {
  readonly limit: number;
  readonly battleId?: string;
}

export interface AutoTurnWindowReader {
  listLockedAutoWindows(input: AutoTurnBatchInput): Promise<readonly string[]>;
}

export interface AutoTurnResolver {
  resolve(turnWindowId: string): Promise<PvpTurnResolutionResult>;
}

export type AutoTurnDispatchOutcome =
  | { readonly windowId: string; readonly result: PvpTurnResolutionResult }
  | { readonly windowId: string; readonly error: unknown };

/** A durable snapshot of work per tick; newly opened windows wait for the next tick. */
export class AutoTurnDispatcher {
  public constructor(
    private readonly windows: AutoTurnWindowReader,
    private readonly resolver: AutoTurnResolver,
  ) {}

  public async runOnce(input: AutoTurnBatchInput): Promise<readonly AutoTurnDispatchOutcome[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error("AUTO turn batch limit must be a positive safe integer");
    }
    const windowIds = await this.windows.listLockedAutoWindows(input);
    const outcomes: AutoTurnDispatchOutcome[] = [];
    for (const windowId of windowIds.slice(0, input.limit)) {
      try {
        // The shared resolver locks and revalidates everything, including concurrent replay.
        outcomes.push({ windowId, result: await this.resolver.resolve(windowId) });
      } catch (error) {
        // Failed transactions remain discoverable after restart; other battles can progress.
        outcomes.push({ windowId, error });
      }
    }
    return outcomes;
  }
}
