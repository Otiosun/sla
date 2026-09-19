import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CounterRandomSource } from "../../platform/rng/counter-rng.js";
import { createIdempotencyKey, parseIdempotencyScope } from "../../shared-kernel/idempotency.js";
import { chooseHeuristicAction } from "./ai.js";
import {
  type BattleAction,
  BattleActionSchema,
  type BattleError,
  type BattleEvent,
  type BattleState,
} from "./contracts.js";
import { initializeBattleState } from "./initialization.js";
import { activeCombatant, usableReserves, validateBattleAction } from "./legal.js";
import type {
  BattleRepository,
  BattleSeedReader,
  BattleTransaction,
  StoredBattleAction,
} from "./ports.js";
import {
  type PvpTurnResolutionErrorCode,
  PvpTurnResolutionService,
} from "./pvp-turn-resolution.js";
import { resolveTurn } from "./resolver.js";
import { normalizeBattleRules } from "./rules.js";
import type { TurnWindowAggregate } from "./turn-window.js";

const idempotencyScopeResult = parseIdempotencyScope("battle.action");
if (!idempotencyScopeResult.ok) throw new Error("Canonical battle idempotency scope is invalid");
const BATTLE_ACTION_SCOPE = idempotencyScopeResult.value;

export type BattleServiceErrorCode =
  | PvpTurnResolutionErrorCode
  | BattleError["code"]
  | "BATTLE_NOT_FOUND"
  | "BATTLE_NOT_INITIALIZED"
  | "BATTLE_INITIALIZATION_INVALID"
  | "BATTLE_VERSION_CONFLICT"
  | "BATTLE_IDEMPOTENCY_CONFLICT"
  | "BATTLE_RNG_UNAVAILABLE";

export interface BattleServiceError {
  readonly code: BattleServiceErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly currentState?: BattleState;
}

export type BattleServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BattleServiceError };

export interface ResolvePlayerTurnInput {
  readonly battleId: string;
  /** A PLAYER submission has a player id; a NARRATOR submission has a principal id. */
  readonly playerId: string | null;
  readonly adminPrincipalId?: string | null;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly action: BattleAction;
}

export interface ResolvePlayerTurnOutput {
  readonly pending?: boolean;
  readonly state: BattleState;
  readonly events: readonly BattleEvent[];
  readonly replayed: boolean;
}

export interface InitializeBattleOutput {
  readonly state: BattleState;
  readonly replayed: boolean;
}

export type IdFactory = () => string;
type PlayerTurnResult = BattleServiceResult<ResolvePlayerTurnOutput>;

class ControllerResolutionFailure extends Error {
  public constructor(readonly result: BattleServiceResult<never>) {
    super("Controller resolution failed; roll back the submitted action");
  }
}

function failure(
  code: BattleServiceErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  currentState?: BattleState,
): BattleServiceResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(currentState === undefined ? {} : { currentState }),
    },
  };
}

function requiredSideNumbers(state: BattleState): readonly number[] {
  const forced = state.sides
    .filter((side) => {
      const active = activeCombatant(state, side.sideNo);
      return (
        active !== undefined &&
        active.currentHp <= 0 &&
        usableReserves(state, side.sideNo).length > 0
      );
    })
    .map((side) => side.sideNo);
  return forced.length > 0
    ? forced
    : state.sides.filter((side) => side.result === null).map((side) => side.sideNo);
}

function actionMatches(
  stored: StoredBattleAction,
  input: ResolvePlayerTurnInput,
  storageKey: string,
): boolean {
  return (
    stored.battleId === input.battleId &&
    stored.expectedBattleVersion === input.expectedVersion &&
    stored.idempotencyKey === storageKey &&
    isDeepStrictEqual(stored.action, input.action)
  );
}

export class BattleService {
  public constructor(
    private readonly repository: BattleRepository,
    private readonly seedReader: BattleSeedReader,
    private readonly idFactory: IdFactory = randomUUID,
  ) {}

  public async initialize(battleId: string): Promise<BattleServiceResult<InitializeBattleOutput>> {
    return this.repository.transaction(async (transaction) => {
      const root = await transaction.loadRoot(battleId, true);
      if (root === null) return failure("BATTLE_NOT_FOUND", "Battle was not found");
      const existing = await transaction.loadState(battleId, 0);
      if (existing !== null) return { ok: true, value: { state: existing, replayed: true } };
      if (root.status !== "CREATED") {
        return failure(
          "BATTLE_INITIALIZATION_INVALID",
          "Battle has no initial snapshot but is no longer in CREATED state",
          { status: root.status },
        );
      }
      const data = await transaction.loadInitializationData(root);
      if (data === null) {
        return failure(
          "BATTLE_INITIALIZATION_INVALID",
          "Battle initialization data could not be assembled from pinned content",
        );
      }
      const built = initializeBattleState({
        root,
        sides: [
          {
            sideNo: 1,
            controllerKind: "PLAYER",
            playerId: data.playerId,
            party: data.playerParty,
            ...(data.playerParties === undefined ? {} : { playerParties: data.playerParties }),
          },
          {
            sideNo: 2,
            controllerKind: root.battleType === "NPC" ? "NPC" : "WILD",
            playerId: null,
            party: data.opponentParty,
          },
        ],
        idFactory: this.idFactory,
      });
      if (!built.ok) {
        return failure(built.error.code, built.error.message, built.error.details);
      }
      const state = await transaction.initialize(root, built.value);
      return { ok: true, value: { state, replayed: false } };
    });
  }

  public async currentState(battleId: string): Promise<BattleServiceResult<BattleState>> {
    return this.repository.read(async (transaction) => {
      const root = await transaction.loadRoot(battleId);
      if (root === null) return failure("BATTLE_NOT_FOUND", "Battle was not found");
      const state = await transaction.loadState(battleId, root.version);
      return state === null
        ? failure("BATTLE_NOT_INITIALIZED", "Battle has no state snapshot")
        : { ok: true, value: state };
    });
  }

  public async resolvePlayerTurn(
    input: ResolvePlayerTurnInput,
  ): Promise<BattleServiceResult<ResolvePlayerTurnOutput>> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      return failure(
        "BATTLE_ACTION_INVALID",
        "expectedVersion must be a non-negative safe integer",
      );
    }
    const parsedAction = BattleActionSchema.safeParse(input.action);
    if (!parsedAction.success) {
      return failure("BATTLE_ACTION_INVALID", "Player action failed schema validation", {
        issues: parsedAction.error.issues,
      });
    }
    const idempotency = createIdempotencyKey(BATTLE_ACTION_SCOPE, input.idempotencyKey);
    if (!idempotency.ok) {
      return failure("BATTLE_ACTION_INVALID", idempotency.error.message, idempotency.error.details);
    }
    const storageKey = idempotency.value.storageKey;

    const result = this.repository.transaction<PlayerTurnResult>(async (transaction) => {
      const root = await transaction.loadRoot(input.battleId, true);
      if (root === null) return failure("BATTLE_NOT_FOUND", "Battle was not found");
      const controllerWindow = await transaction.loadTurnWindowByBattleVersion(
        input.battleId,
        input.expectedVersion,
      );
      if (controllerWindow?.window.requiredControllers !== undefined) {
        return this.resolveControllerPlayerTurn(transaction, controllerWindow, input);
      }
      if (parsedAction.data.type === "CAPTURE_ATTEMPT") {
        return failure(
          "BATTLE_ACTION_INVALID",
          "Capture attempts must be reserved by the capture transaction",
        );
      }
      const existing = await transaction.findAction(storageKey, true);
      if (existing !== null) {
        if (!actionMatches(existing, input, storageKey)) {
          return failure(
            "BATTLE_IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for different battle input",
          );
        }
        if (existing.status === "RESOLVED" && existing.resolvedBattleVersion !== null) {
          const replay = await transaction.loadState(
            input.battleId,
            existing.resolvedBattleVersion,
          );
          if (replay === null) {
            return failure(
              "BATTLE_STATE_INVALID",
              "Resolved idempotent action points to a missing battle snapshot",
            );
          }
          return { ok: true, value: { state: replay, events: [], replayed: true } };
        }
        const current = await transaction.loadState(input.battleId, root.version);
        return failure(
          "BATTLE_VERSION_CONFLICT",
          "Previously rejected or incomplete action cannot be resolved again",
          { actionStatus: existing.status },
          current ?? undefined,
        );
      }

      const state = await transaction.loadState(input.battleId, root.version);
      if (state === null)
        return failure("BATTLE_NOT_INITIALIZED", "Battle has no current snapshot");
      if (root.version !== input.expectedVersion || state.version !== input.expectedVersion) {
        const actionId = this.idFactory();
        const correlationId = this.idFactory();
        await transaction.rejectAction({
          actionId,
          battleId: input.battleId,
          expectedVersion: input.expectedVersion,
          idempotencyKey: storageKey,
          correlationId,
          action: parsedAction.data,
        });
        return failure(
          "BATTLE_VERSION_CONFLICT",
          "Battle version is stale",
          { expectedVersion: input.expectedVersion, currentVersion: root.version },
          state,
        );
      }

      const playerSide = state.sides.find(
        (side) => side.controllerKind === "PLAYER" && side.playerId === input.playerId,
      );
      const actor = state.combatants.find(
        (entry) => entry.participantId === parsedAction.data.actorParticipantId,
      );
      if (
        playerSide === undefined ||
        actor === undefined ||
        actor.sideNo !== playerSide.sideNo ||
        !playerSide.participantIds.includes(actor.participantId)
      ) {
        return failure("BATTLE_ACTION_INVALID", "Action actor is not controlled by this player");
      }

      const ruleset = await transaction.loadRuleset(root.rulesetId);
      if (ruleset === null)
        return failure("BATTLE_STATE_INVALID", "Pinned battle ruleset is missing");
      const normalized = normalizeBattleRules(ruleset);
      if (!normalized.ok) return { ok: false, error: normalized.error };
      const invalid = validateBattleAction(state, parsedAction.data, normalized.value);
      if (invalid !== null) return { ok: false, error: invalid };

      let seed: Uint8Array;
      try {
        seed = this.seedReader.decrypt(root);
      } catch (error) {
        return failure("BATTLE_RNG_UNAVAILABLE", "Battle RNG seed could not be recovered", {
          cause: error instanceof Error ? error.message : "unknown",
          keyVersion: root.seed.keyVersion,
        });
      }
      const rng = new CounterRandomSource(seed, root.rngCounter);
      const requiredSides = new Set(requiredSideNumbers(state));
      if (!requiredSides.has(playerSide.sideNo)) {
        return failure("BATTLE_ACTION_INVALID", "Player side is not currently required to act");
      }
      const actions: BattleAction[] = [parsedAction.data];
      for (const side of state.sides) {
        if (side.sideNo === playerSide.sideNo || !requiredSides.has(side.sideNo)) continue;
        if (side.controllerKind === "PLAYER") {
          return failure(
            "BATTLE_ACTION_INVALID",
            "Multi-player action collection is not enabled in Battle Engine v1",
          );
        }
        const action = chooseHeuristicAction(state, side.sideNo, normalized.value, rng);
        if (action === null) {
          return failure("BATTLE_STATE_INVALID", "AI side has no legal action to resolve");
        }
        actions.push(action);
      }

      const resolved = resolveTurn(state, actions, normalized.value, rng);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const actionId = this.idFactory();
      const correlationId = this.idFactory();
      const persisted = await transaction.persistTurn({
        actionId,
        battleId: input.battleId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: storageKey,
        correlationId,
        playerAction: parsedAction.data,
        nextState: resolved.value.state,
        events: resolved.value.events,
        rngCounter: rng.counter,
      });
      if (persisted.kind === "VERSION_CONFLICT") {
        return failure(
          "BATTLE_VERSION_CONFLICT",
          "Another resolver won the battle version race",
          { expectedVersion: input.expectedVersion },
          persisted.currentState,
        );
      }
      return {
        ok: true,
        value: { state: persisted.state, events: resolved.value.events, replayed: false },
      };
    });
    return result.catch((error: unknown) => {
      if (error instanceof ControllerResolutionFailure) return error.result;
      throw error;
    });
  }

  private async resolveControllerPlayerTurn(
    transaction: BattleTransaction,
    aggregate: TurnWindowAggregate,
    input: ResolvePlayerTurnInput,
  ): Promise<BattleServiceResult<ResolvePlayerTurnOutput>> {
    const required = aggregate.window.requiredControllers?.find(
      (entry) =>
        entry.participantId === input.action.actorParticipantId &&
        ((entry.kind === "PLAYER" &&
          entry.playerId === input.playerId &&
          input.adminPrincipalId === undefined) ||
          (entry.kind === "NARRATOR" &&
            entry.adminPrincipalId === input.adminPrincipalId &&
            input.playerId === null)),
    );
    if (required === undefined)
      return failure("BATTLE_ACTION_INVALID", "Action actor is not required for this player");
    const state = await transaction.loadState(input.battleId, input.expectedVersion);
    if (state === null) return failure("BATTLE_STATE_INVALID", "Turn window snapshot is missing");
    const ruleset = await transaction.loadRuleset(state.rulesetId);
    if (ruleset === null)
      return failure("BATTLE_STATE_INVALID", "Pinned battle ruleset is missing");
    const rules = normalizeBattleRules(ruleset);
    if (!rules.ok) return rules;
    if (input.action.type === "CAPTURE_ATTEMPT") {
      const reserved = aggregate.submissions.some(
        (entry) =>
          entry.status === "ACTIVE" &&
          entry.playerId === input.playerId &&
          isDeepStrictEqual(entry.action, input.action),
      );
      if (!reserved) {
        return failure("BATTLE_ACTION_INVALID", "Capture attempt has no durable turn reservation");
      }
    }
    const invalid = validateBattleAction(state, input.action, rules.value);
    if (invalid !== null) return { ok: false, error: invalid };
    const submitted = await transaction.submitTurnAction(aggregate.window.id, {
      id: this.idFactory(),
      playerId: input.playerId,
      ...(input.adminPrincipalId === undefined ? {} : { adminPrincipalId: input.adminPrincipalId }),
      sideNo: required.sideNo,
      controllerRevision: required.revision,
      expectedBattleVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      action: input.action,
      submittedAt: new Date(),
    });
    if (!submitted.ok) return submitted;
    if (submitted.value.aggregate.window.status === "COLLECTING") {
      return {
        ok: true,
        value: { state, events: [], pending: true, replayed: submitted.value.replayed },
      };
    }
    const resolver = new PvpTurnResolutionService(
      {
        transaction: async (work) => work(transaction.turnResolution),
      },
      this.seedReader,
      this.idFactory,
    );
    const resolved = await resolver.resolve(aggregate.window.id);
    if (!resolved.ok) throw new ControllerResolutionFailure(resolved);
    return resolved;
  }
}
