import { randomUUID } from "node:crypto";
import { CounterRandomSource } from "../../platform/rng/counter-rng.js";
import type { RulesetSnapshot } from "../catalog/contracts.js";
import { chooseHeuristicAction } from "./ai.js";
import type { BattleAction, BattleCombatant, BattleEvent, BattleState } from "./contracts.js";
import { validateBattleAction } from "./legal.js";
import type { BattleParticipantController } from "./participant-controller.js";
import type { BattleRootRecord, BattleSeedReader } from "./ports.js";
import { requiredActionParticipants, resolveTurn } from "./resolver.js";
import { normalizeBattleRules } from "./rules.js";
import {
  type BattleTurnSubmission,
  commitTurnWindow,
  type TurnWindowAggregate,
  type TurnWindowErrorCode,
} from "./turn-window.js";

export interface PersistPvpTurnResolutionInput {
  readonly battleId: string;
  readonly expectedVersion: number;
  readonly lockedWindow: TurnWindowAggregate;
  readonly committedWindow: TurnWindowAggregate;
  readonly nextState: BattleState;
  readonly events: readonly BattleEvent[];
  readonly rngCounter: bigint;
  readonly causationId: string;
  readonly correlationId: string;
}

export type PersistPvpTurnResolutionResult =
  | { readonly kind: "PERSISTED"; readonly state: BattleState }
  | { readonly kind: "VERSION_CONFLICT"; readonly currentState: BattleState };

export interface PvpTurnResolutionTransaction {
  loadParticipantControllers(battleId: string): Promise<readonly BattleParticipantController[]>;
  loadTurnWindow(turnWindowId: string, lock?: boolean): Promise<TurnWindowAggregate | null>;
  loadBattleRoot(battleId: string, lock?: boolean): Promise<BattleRootRecord | null>;
  loadRuleset(rulesetId: string): Promise<RulesetSnapshot | null>;
  loadBattleState(battleId: string, version: number): Promise<BattleState | null>;
  persistResolution(input: PersistPvpTurnResolutionInput): Promise<PersistPvpTurnResolutionResult>;
}

export interface PvpTurnResolutionRepository {
  transaction<T>(work: (transaction: PvpTurnResolutionTransaction) => Promise<T>): Promise<T>;
}

export type PvpTurnResolutionErrorCode =
  | TurnWindowErrorCode
  | "TURN_WINDOW_NOT_FOUND"
  | "BATTLE_NOT_FOUND"
  | "BATTLE_NOT_ACTIVE"
  | "BATTLE_VERSION_CONFLICT"
  | "BATTLE_STATE_INVALID"
  | "BATTLE_ACTION_INVALID"
  | "BATTLE_RNG_UNAVAILABLE";

export interface PvpTurnResolutionError {
  readonly code: PvpTurnResolutionErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly currentState?: BattleState;
}

export type PvpTurnResolutionFailure = {
  readonly ok: false;
  readonly error: PvpTurnResolutionError;
};

export type PvpTurnResolutionResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly state: BattleState;
        readonly events: readonly BattleEvent[];
        readonly replayed: boolean;
      };
    }
  | PvpTurnResolutionFailure;

type IdFactory = () => string;
type Clock = () => Date;

type SubmissionValidationResult =
  | { readonly ok: true; readonly value: readonly BattleTurnSubmission[] }
  | PvpTurnResolutionFailure;

function failure(
  code: PvpTurnResolutionErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  currentState?: BattleState,
): PvpTurnResolutionFailure {
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

function validateSubmissionOwnership(
  state: BattleState,
  aggregate: TurnWindowAggregate,
): SubmissionValidationResult {
  const actions: BattleTurnSubmission[] = [];
  const requiredPlayers = [...aggregate.window.requiredPlayers].sort(
    (left, right) => left.sideNo - right.sideNo,
  );

  for (const required of requiredPlayers) {
    const side = state.sides.find((entry) => entry.sideNo === required.sideNo);
    if (
      side === undefined ||
      side.controllerKind !== "PLAYER" ||
      side.playerId !== required.playerId
    ) {
      return failure(
        "BATTLE_ACTION_INVALID",
        "Turn window player does not control the required battle side",
        { playerId: required.playerId, sideNo: required.sideNo },
      );
    }

    const active = aggregate.submissions.filter(
      (entry) => entry.playerId === required.playerId && entry.status === "ACTIVE",
    );
    if (active.length !== 1) {
      return failure(
        "TURN_WINDOW_INCOMPLETE",
        "Locked turn window must contain exactly one active submission per required player",
        { playerId: required.playerId, activeSubmissions: active.length },
      );
    }
    const submission = active[0];
    if (submission === undefined) {
      return failure("TURN_WINDOW_INCOMPLETE", "Required turn submission is missing");
    }
    if (
      submission.sideNo !== required.sideNo ||
      submission.expectedBattleVersion !== aggregate.window.battleVersion
    ) {
      return failure(
        "BATTLE_VERSION_CONFLICT",
        "Turn submission does not match the locked battle version and side",
      );
    }

    const actor = state.combatants.find(
      (entry) => entry.participantId === submission.action.actorParticipantId,
    );
    if (
      actor === undefined ||
      actor.sideNo !== side.sideNo ||
      !side.participantIds.includes(actor.participantId)
    ) {
      return failure("BATTLE_ACTION_INVALID", "Turn action actor is not controlled by its player");
    }
    actions.push(submission);
  }

  const activeCount = aggregate.submissions.filter((entry) => entry.status === "ACTIVE").length;
  if (activeCount !== actions.length) {
    return failure(
      "TURN_WINDOW_INCOMPLETE",
      "Locked turn window contains unexpected active actions",
    );
  }
  return { ok: true, value: actions };
}

function validateControllerSubmissions(
  state: BattleState,
  aggregate: TurnWindowAggregate,
  controllers: readonly BattleParticipantController[],
):
  | {
      readonly ok: true;
      readonly actions: readonly BattleAction[];
      readonly autoActors: readonly BattleCombatant[];
    }
  | PvpTurnResolutionFailure {
  const requirements = aggregate.window.requiredControllers ?? [];
  const actions: BattleAction[] = [];
  const autoActors: BattleCombatant[] = [];
  let humanCount = 0;
  for (const actor of requiredActionParticipants(state)) {
    const sideNo = actor.sideNo;
    const side = state.sides.find((s) => s.sideNo === sideNo);
    const controller = controllers.find((c) => c.participantId === actor.participantId);
    if (side === undefined || controller === undefined || controller.battleId !== state.battleId) {
      return failure("BATTLE_STATE_INVALID", "Required actor has no persisted controller");
    }
    if (controller.kind === "AUTO") {
      autoActors.push(actor);
      continue;
    }
    humanCount += 1;
    const required = requirements.find((r) => r.participantId === controller.participantId);
    if (
      required === undefined ||
      required.kind !== controller.kind ||
      required.sideNo !== sideNo ||
      required.revision !== controller.revision ||
      required.playerId !== controller.playerId ||
      required.adminPrincipalId !== controller.adminPrincipalId
    ) {
      return failure("BATTLE_ACTION_INVALID", "Human controller snapshot is stale or incomplete");
    }
    const active = aggregate.submissions.filter(
      (s) => s.status === "ACTIVE" && s.action.actorParticipantId === controller.participantId,
    );
    const submission = active[0];
    if (
      active.length !== 1 ||
      submission === undefined ||
      submission.sideNo !== sideNo ||
      submission.expectedBattleVersion !== state.version ||
      submission.playerId !== controller.playerId ||
      (submission.adminPrincipalId ?? null) !== controller.adminPrincipalId ||
      submission.controllerRevision !== controller.revision
    ) {
      return failure(
        "TURN_WINDOW_INCOMPLETE",
        "Required human action does not match its controller",
      );
    }
    actions.push(submission.action);
  }
  if (
    requirements.length !== humanCount ||
    aggregate.submissions.filter((s) => s.status === "ACTIVE").length !== actions.length
  ) {
    return failure(
      "TURN_WINDOW_INCOMPLETE",
      "Turn window contains unexpected requirements or actions",
    );
  }
  return { ok: true, actions, autoActors };
}

export class PvpTurnResolutionService {
  public constructor(
    private readonly repository: PvpTurnResolutionRepository,
    private readonly seedReader: BattleSeedReader,
    private readonly idFactory: IdFactory = randomUUID,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async resolve(turnWindowId: string): Promise<PvpTurnResolutionResult> {
    return this.repository.transaction(async (transaction) => {
      const discovered = await transaction.loadTurnWindow(turnWindowId, false);
      if (discovered === null) {
        return failure("TURN_WINDOW_NOT_FOUND", "Turn window was not found");
      }

      const root = await transaction.loadBattleRoot(discovered.window.battleId, true);
      if (root === null) return failure("BATTLE_NOT_FOUND", "Battle was not found");

      const aggregate = await transaction.loadTurnWindow(turnWindowId, true);
      if (aggregate === null) return failure("TURN_WINDOW_NOT_FOUND", "Turn window was not found");
      if (aggregate.window.battleId !== root.battleId) {
        return failure("BATTLE_STATE_INVALID", "Turn window changed battle identity while locking");
      }

      if (aggregate.window.status === "COMMITTED") {
        const resolvedVersion = aggregate.window.resolvedBattleVersion;
        if (resolvedVersion === null || aggregate.window.resolutionCorrelationId === null) {
          return failure(
            "BATTLE_STATE_INVALID",
            "Committed turn window has no resolution identity",
          );
        }
        const replay = await transaction.loadBattleState(root.battleId, resolvedVersion);
        if (replay === null) {
          return failure(
            "BATTLE_STATE_INVALID",
            "Committed turn window points to a missing snapshot",
          );
        }
        return { ok: true, value: { state: replay, events: [], replayed: true } };
      }

      if (aggregate.window.status !== "LOCKED") {
        return failure("TURN_WINDOW_NOT_LOCKED", "Only a locked turn window can be resolved");
      }
      if (root.battleType !== "PVP" && aggregate.window.requiredControllers === undefined) {
        return failure("BATTLE_STATE_INVALID", "Turn window does not belong to a PVP battle");
      }
      if (root.status !== "ACTIVE") {
        return failure("BATTLE_NOT_ACTIVE", "PVP battle is not active");
      }
      if (
        root.version !== aggregate.window.battleVersion ||
        root.turnNumber !== aggregate.window.turnNumber
      ) {
        const current = await transaction.loadBattleState(root.battleId, root.version);
        return failure(
          "BATTLE_VERSION_CONFLICT",
          "Turn window targets a stale battle state",
          {
            windowVersion: aggregate.window.battleVersion,
            currentVersion: root.version,
            windowTurnNumber: aggregate.window.turnNumber,
            currentTurnNumber: root.turnNumber,
          },
          current ?? undefined,
        );
      }

      const state = await transaction.loadBattleState(root.battleId, root.version);
      if (state === null) return failure("BATTLE_STATE_INVALID", "Battle has no current snapshot");
      if (
        state.battleType !== root.battleType ||
        state.version !== root.version ||
        state.turnNumber !== root.turnNumber
      ) {
        return failure("BATTLE_STATE_INVALID", "Battle root and PVP snapshot are inconsistent");
      }

      let actions: BattleAction[];
      let autoActors: readonly BattleCombatant[] = [];
      if (aggregate.window.requiredControllers !== undefined) {
        const validated = validateControllerSubmissions(
          state,
          aggregate,
          await transaction.loadParticipantControllers(root.battleId),
        );
        if (!validated.ok) return validated;
        actions = [...validated.actions];
        autoActors = validated.autoActors;
      } else {
        const submissions = validateSubmissionOwnership(state, aggregate);
        if (!submissions.ok) return submissions;
        actions = submissions.value.map((entry) => entry.action);
      }

      const ruleset = await transaction.loadRuleset(root.rulesetId);
      if (ruleset === null)
        return failure("BATTLE_STATE_INVALID", "Pinned battle ruleset is missing");
      const normalized = normalizeBattleRules(ruleset);
      if (!normalized.ok) {
        return failure(normalized.error.code, normalized.error.message, normalized.error.details);
      }
      for (const action of actions) {
        const invalid = validateBattleAction(state, action, normalized.value);
        if (invalid !== null) return failure(invalid.code, invalid.message, invalid.details);
      }

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
      for (const actor of autoActors) {
        const action = chooseHeuristicAction(
          state,
          actor.sideNo,
          normalized.value,
          rng,
          actor.participantId,
        );
        if (action === null)
          return failure("BATTLE_ACTION_INVALID", "AUTO controller has no legal action");
        actions.push(action);
      }
      // Canonical ordering makes tie RNG independent of human arrival and controller kind.
      actions.sort((a, b) => {
        const sideA =
          state.combatants.find((c) => c.participantId === a.actorParticipantId)?.sideNo ?? 0;
        const sideB =
          state.combatants.find((c) => c.participantId === b.actorParticipantId)?.sideNo ?? 0;
        return sideA - sideB || a.actorParticipantId.localeCompare(b.actorParticipantId);
      });
      const resolved = resolveTurn(state, actions, normalized.value, rng);
      if (!resolved.ok) {
        return failure(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const correlationId = this.idFactory();
      const committed = commitTurnWindow(aggregate, {
        resolvedBattleVersion: resolved.value.state.version,
        correlationId,
        committedAt: this.clock(),
      });
      if (!committed.ok) {
        return failure(committed.error.code, committed.error.message, committed.error.details);
      }

      const persisted = await transaction.persistResolution({
        battleId: root.battleId,
        expectedVersion: root.version,
        lockedWindow: aggregate,
        committedWindow: committed.value.aggregate,
        nextState: resolved.value.state,
        events: resolved.value.events,
        rngCounter: rng.counter,
        causationId: aggregate.window.id,
        correlationId,
      });
      if (persisted.kind === "VERSION_CONFLICT") {
        return failure(
          "BATTLE_VERSION_CONFLICT",
          "Another resolver won the PVP battle version race",
          { expectedVersion: root.version },
          persisted.currentState,
        );
      }

      return {
        ok: true,
        value: {
          state: persisted.state,
          events: resolved.value.events,
          replayed: false,
        },
      };
    });
  }
}
