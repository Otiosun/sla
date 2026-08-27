import type { BattleEvent, BattleState } from "./contracts.js";
import type {
  BattleServiceError,
  BattleServiceResult,
  InitializeBattleOutput,
  ResolvePlayerTurnInput,
  ResolvePlayerTurnOutput,
} from "./service.js";

export interface BattleCorePort {
  initialize(battleId: string): Promise<BattleServiceResult<InitializeBattleOutput>>;
  currentState(battleId: string): Promise<BattleServiceResult<BattleState>>;
  resolvePlayerTurn(
    input: ResolvePlayerTurnInput,
  ): Promise<BattleServiceResult<ResolvePlayerTurnOutput>>;
}

export interface BattleAftermathResult {
  readonly relocatedPlayerIds: readonly string[];
}

export interface BattleAftermathPort {
  applyDefeat(state: BattleState): Promise<BattleAftermathResult>;
}

export interface CancelBattleInput {
  readonly battleId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly requestFingerprint?: string;
}

export interface CancelBattleOutput {
  readonly state: BattleState;
  readonly events: readonly BattleEvent[];
  readonly replayed: boolean;
}

export type BattleCancellationPersistenceResult =
  | {
      readonly kind: "PERSISTED";
      readonly state: BattleState;
      readonly events: readonly BattleEvent[];
    }
  | { readonly kind: "REPLAYED"; readonly state: BattleState }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "NOT_INITIALIZED" }
  | { readonly kind: "NOT_ACTIVE"; readonly currentState: BattleState }
  | { readonly kind: "VERSION_CONFLICT"; readonly currentState: BattleState };

export interface BattleCancellationPort {
  cancel(input: CancelBattleInput): Promise<BattleCancellationPersistenceResult>;
}

export type BattleRuntimeError = Omit<BattleServiceError, "code"> & {
  readonly code: BattleServiceError["code"] | "BATTLE_AFTERMATH_FAILED";
};

export type BattleRuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BattleRuntimeError };

function runtimeFailure(
  code: BattleRuntimeError["code"],
  message: string,
  currentState?: BattleState,
  details?: Readonly<Record<string, unknown>>,
): BattleRuntimeResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(currentState === undefined ? {} : { currentState }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

export class BattleRuntimeService {
  public constructor(
    private readonly core: BattleCorePort,
    private readonly aftermath: BattleAftermathPort,
    private readonly cancellation: BattleCancellationPort,
  ) {}

  public initialize(battleId: string): Promise<BattleServiceResult<InitializeBattleOutput>> {
    return this.core.initialize(battleId);
  }

  public currentState(battleId: string): Promise<BattleServiceResult<BattleState>> {
    return this.core.currentState(battleId);
  }

  public async resolvePlayerTurn(
    input: ResolvePlayerTurnInput,
  ): Promise<BattleRuntimeResult<ResolvePlayerTurnOutput>> {
    const resolved = await this.core.resolvePlayerTurn(input);
    if (!resolved.ok) return resolved;

    if (resolved.value.state.status === "LOST") {
      try {
        await this.aftermath.applyDefeat(resolved.value.state);
      } catch {
        return runtimeFailure(
          "BATTLE_AFTERMATH_FAILED",
          "Battle was resolved, but defeat aftermath has not been confirmed yet",
          resolved.value.state,
        );
      }
    }

    return resolved;
  }

  public async cancel(input: CancelBattleInput): Promise<BattleRuntimeResult<CancelBattleOutput>> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      return runtimeFailure(
        "BATTLE_ACTION_INVALID",
        "expectedVersion must be a non-negative safe integer",
      );
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 256) {
      return runtimeFailure(
        "BATTLE_ACTION_INVALID",
        "Cancellation reason must contain 1..256 characters",
      );
    }

    const persisted = await this.cancellation.cancel({ ...input, reason });
    switch (persisted.kind) {
      case "PERSISTED":
        return {
          ok: true,
          value: { state: persisted.state, events: persisted.events, replayed: false },
        };
      case "REPLAYED":
        return { ok: true, value: { state: persisted.state, events: [], replayed: true } };
      case "IDEMPOTENCY_CONFLICT":
        return runtimeFailure(
          "BATTLE_ACTION_INVALID",
          "Battle cancellation idempotency evidence conflicts with the request",
        );
      case "NOT_FOUND":
        return runtimeFailure("BATTLE_NOT_FOUND", "Battle was not found");
      case "NOT_INITIALIZED":
        return runtimeFailure("BATTLE_NOT_INITIALIZED", "Battle has no state snapshot");
      case "NOT_ACTIVE":
        return runtimeFailure(
          "BATTLE_NOT_ACTIVE",
          "Only an active battle can be cancelled",
          persisted.currentState,
        );
      case "VERSION_CONFLICT":
        return runtimeFailure(
          "BATTLE_VERSION_CONFLICT",
          "Battle version is stale",
          persisted.currentState,
          {
            expectedVersion: input.expectedVersion,
            currentVersion: persisted.currentState.version,
          },
        );
    }
  }
}
