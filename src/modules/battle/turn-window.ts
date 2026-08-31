import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createIdempotencyKey, parseIdempotencyScope } from "../../shared-kernel/idempotency.js";
import { BattleActionSchema, type BattleAction } from "./contracts.js";

const idempotencyScopeResult = parseIdempotencyScope("battle.turn.submission");
if (!idempotencyScopeResult.ok)
  throw new Error("Canonical turn submission idempotency scope is invalid");
const TURN_SUBMISSION_SCOPE = idempotencyScopeResult.value;

const uuid = z.string().uuid();

export type TurnWindowStatus = "COLLECTING" | "LOCKED" | "COMMITTED" | "CANCELLED";
export type TurnSubmissionStatus = "ACTIVE" | "SUPERSEDED" | "COMMITTED" | "REJECTED";

export interface RequiredTurnPlayer {
  readonly playerId: string;
  readonly sideNo: number;
}

export interface BattleTurnWindow {
  readonly id: string;
  readonly battleId: string;
  readonly battleVersion: number;
  readonly turnNumber: number;
  readonly status: TurnWindowStatus;
  readonly openedAt: string;
  readonly deadlineAt: string;
  readonly lockedAt: string | null;
  readonly committedAt: string | null;
  readonly revision: number;
  readonly resolutionCorrelationId: string | null;
  readonly resolvedBattleVersion: number | null;
  readonly requiredPlayers: readonly RequiredTurnPlayer[];
}

export interface BattleTurnSubmission {
  readonly id: string;
  readonly playerId: string;
  readonly sideNo: number;
  readonly expectedBattleVersion: number;
  readonly idempotencyKey: string;
  readonly action: BattleAction;
  readonly submissionRevision: number;
  readonly status: TurnSubmissionStatus;
  readonly submittedAt: string;
}

export interface TurnWindowAggregate {
  readonly window: BattleTurnWindow;
  readonly submissions: readonly BattleTurnSubmission[];
}

export type TurnWindowErrorCode =
  | "TURN_WINDOW_INVALID"
  | "TURN_WINDOW_PLAYER_NOT_REQUIRED"
  | "TURN_WINDOW_VERSION_CONFLICT"
  | "TURN_WINDOW_IDEMPOTENCY_CONFLICT"
  | "TURN_WINDOW_NOT_COLLECTING"
  | "TURN_WINDOW_EXPIRED"
  | "TURN_WINDOW_NOT_LOCKED"
  | "TURN_WINDOW_INCOMPLETE"
  | "TURN_WINDOW_COMMIT_CONFLICT";

export interface TurnWindowError {
  readonly code: TurnWindowErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type TurnWindowResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TurnWindowError };

export interface CreateTurnWindowInput {
  readonly id: string;
  readonly battleId: string;
  readonly battleVersion: number;
  readonly turnNumber: number;
  readonly openedAt: Date;
  readonly deadlineAt: Date;
  readonly requiredPlayers: readonly RequiredTurnPlayer[];
}

export interface SubmitTurnActionInput {
  readonly id: string;
  readonly playerId: string;
  readonly sideNo: number;
  readonly expectedBattleVersion: number;
  readonly idempotencyKey: string;
  readonly action: BattleAction;
  readonly submittedAt: Date;
}

export interface SubmitTurnActionOutput {
  readonly aggregate: TurnWindowAggregate;
  readonly replayed: boolean;
}

export interface TurnWindowOwnSubmissionView {
  readonly submissionRevision: number;
  readonly submittedAt: string;
  readonly action: BattleAction;
}

export interface TurnWindowView {
  readonly battleId: string;
  readonly battleVersion: number;
  readonly turnNumber: number;
  readonly status: TurnWindowStatus;
  readonly deadlineAt: string;
  readonly submittedPlayerIds: readonly string[];
  readonly ownSubmission: TurnWindowOwnSubmissionView | null;
}

export interface CommitTurnWindowInput {
  readonly resolvedBattleVersion: number;
  readonly correlationId: string;
  readonly committedAt: Date;
}

export interface CommitTurnWindowOutput {
  readonly aggregate: TurnWindowAggregate;
  readonly replayed: boolean;
}

function failure(
  code: TurnWindowErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): TurnWindowResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function cloneAggregate(aggregate: TurnWindowAggregate): TurnWindowAggregate {
  return structuredClone(aggregate);
}

function finalSubmissionForPlayer(
  aggregate: TurnWindowAggregate,
  playerId: string,
): BattleTurnSubmission | undefined {
  return aggregate.submissions.find(
    (entry) =>
      entry.playerId === playerId && (entry.status === "ACTIVE" || entry.status === "COMMITTED"),
  );
}

function allRequiredPlayersSubmitted(aggregate: TurnWindowAggregate): boolean {
  return aggregate.window.requiredPlayers.every(
    (required) => finalSubmissionForPlayer(aggregate, required.playerId) !== undefined,
  );
}

function submissionMatches(existing: BattleTurnSubmission, input: SubmitTurnActionInput): boolean {
  return (
    existing.playerId === input.playerId &&
    existing.sideNo === input.sideNo &&
    existing.expectedBattleVersion === input.expectedBattleVersion &&
    isDeepStrictEqual(existing.action, input.action)
  );
}

export function createTurnWindow(
  input: CreateTurnWindowInput,
): TurnWindowResult<TurnWindowAggregate> {
  if (!uuid.safeParse(input.id).success || !uuid.safeParse(input.battleId).success) {
    return failure("TURN_WINDOW_INVALID", "Turn window ids must be valid UUIDs");
  }
  if (
    !isNonNegativeSafeInteger(input.battleVersion) ||
    !isNonNegativeSafeInteger(input.turnNumber)
  ) {
    return failure(
      "TURN_WINDOW_INVALID",
      "battleVersion and turnNumber must be non-negative safe integers",
    );
  }
  if (!isValidDate(input.openedAt) || !isValidDate(input.deadlineAt)) {
    return failure("TURN_WINDOW_INVALID", "Turn window timestamps must be valid dates");
  }
  if (input.deadlineAt.getTime() <= input.openedAt.getTime()) {
    return failure("TURN_WINDOW_INVALID", "Turn window deadline must be after openedAt");
  }
  if (input.requiredPlayers.length < 2) {
    return failure("TURN_WINDOW_INVALID", "PVP turn window requires at least two human players");
  }

  const playerIds = new Set<string>();
  const sideNos = new Set<number>();
  for (const required of input.requiredPlayers) {
    if (!uuid.safeParse(required.playerId).success || !isPositiveSafeInteger(required.sideNo)) {
      return failure("TURN_WINDOW_INVALID", "Required player identity or side is invalid");
    }
    if (playerIds.has(required.playerId) || sideNos.has(required.sideNo)) {
      return failure("TURN_WINDOW_INVALID", "Required players and side numbers must be unique");
    }
    playerIds.add(required.playerId);
    sideNos.add(required.sideNo);
  }

  return {
    ok: true,
    value: {
      window: {
        id: input.id,
        battleId: input.battleId,
        battleVersion: input.battleVersion,
        turnNumber: input.turnNumber,
        status: "COLLECTING",
        openedAt: input.openedAt.toISOString(),
        deadlineAt: input.deadlineAt.toISOString(),
        lockedAt: null,
        committedAt: null,
        revision: 0,
        resolutionCorrelationId: null,
        resolvedBattleVersion: null,
        requiredPlayers: input.requiredPlayers.map((entry) => ({ ...entry })),
      },
      submissions: [],
    },
  };
}

export function submitTurnAction(
  aggregate: TurnWindowAggregate,
  input: SubmitTurnActionInput,
): TurnWindowResult<SubmitTurnActionOutput> {
  if (!uuid.safeParse(input.id).success || !uuid.safeParse(input.playerId).success) {
    return failure("TURN_WINDOW_INVALID", "Submission ids must be valid UUIDs");
  }
  if (
    !isPositiveSafeInteger(input.sideNo) ||
    !isNonNegativeSafeInteger(input.expectedBattleVersion)
  ) {
    return failure("TURN_WINDOW_INVALID", "Submission side/version is invalid");
  }
  if (!isValidDate(input.submittedAt)) {
    return failure("TURN_WINDOW_INVALID", "submittedAt must be a valid date");
  }
  const parsedAction = BattleActionSchema.safeParse(input.action);
  if (!parsedAction.success) {
    return failure("TURN_WINDOW_INVALID", "Turn action failed schema validation", {
      issues: parsedAction.error.issues,
    });
  }
  const idempotency = createIdempotencyKey(TURN_SUBMISSION_SCOPE, input.idempotencyKey);
  if (!idempotency.ok) {
    return failure("TURN_WINDOW_INVALID", idempotency.error.message, idempotency.error.details);
  }
  const storageKey = idempotency.value.storageKey;
  const existing = aggregate.submissions.find((entry) => entry.idempotencyKey === storageKey);
  if (existing !== undefined) {
    if (!submissionMatches(existing, { ...input, action: parsedAction.data })) {
      return failure(
        "TURN_WINDOW_IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for a different turn submission",
      );
    }
    return { ok: true, value: { aggregate: cloneAggregate(aggregate), replayed: true } };
  }

  if (aggregate.window.status !== "COLLECTING") {
    return failure("TURN_WINDOW_NOT_COLLECTING", "Turn window is no longer collecting actions");
  }
  if (input.expectedBattleVersion !== aggregate.window.battleVersion) {
    return failure("TURN_WINDOW_VERSION_CONFLICT", "Submission targets a stale battle version", {
      expectedVersion: input.expectedBattleVersion,
      currentVersion: aggregate.window.battleVersion,
    });
  }
  if (input.submittedAt.getTime() >= Date.parse(aggregate.window.deadlineAt)) {
    return failure("TURN_WINDOW_EXPIRED", "Turn window deadline has expired");
  }

  const required = aggregate.window.requiredPlayers.find(
    (entry) => entry.playerId === input.playerId,
  );
  if (required === undefined || required.sideNo !== input.sideNo) {
    return failure(
      "TURN_WINDOW_PLAYER_NOT_REQUIRED",
      "Player is not required to act for this turn window",
    );
  }

  const next = cloneAggregate(aggregate);
  const priorActiveIndexes = next.submissions
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.playerId === input.playerId && entry.status === "ACTIVE");
  const nextSubmissionRevision =
    next.submissions
      .filter((entry) => entry.playerId === input.playerId)
      .reduce((max, entry) => Math.max(max, entry.submissionRevision), 0) + 1;

  const submissions = next.submissions.map((entry, index) =>
    priorActiveIndexes.some((prior) => prior.index === index)
      ? { ...entry, status: "SUPERSEDED" as const }
      : entry,
  );
  submissions.push({
    id: input.id,
    playerId: input.playerId,
    sideNo: input.sideNo,
    expectedBattleVersion: input.expectedBattleVersion,
    idempotencyKey: storageKey,
    action: parsedAction.data,
    submissionRevision: nextSubmissionRevision,
    status: "ACTIVE",
    submittedAt: input.submittedAt.toISOString(),
  });

  let window: BattleTurnWindow = { ...next.window, revision: next.window.revision + 1 };
  const withSubmission: TurnWindowAggregate = { window, submissions };
  if (allRequiredPlayersSubmitted(withSubmission)) {
    window = {
      ...window,
      status: "LOCKED",
      lockedAt: input.submittedAt.toISOString(),
      revision: window.revision + 1,
    };
  }

  return {
    ok: true,
    value: { aggregate: { window, submissions }, replayed: false },
  };
}

export function getTurnWindowView(
  aggregate: TurnWindowAggregate,
  viewerPlayerId: string,
): TurnWindowResult<TurnWindowView> {
  const required = aggregate.window.requiredPlayers.find(
    (entry) => entry.playerId === viewerPlayerId,
  );
  if (required === undefined) {
    return failure("TURN_WINDOW_PLAYER_NOT_REQUIRED", "Player cannot view this turn window");
  }

  const own = finalSubmissionForPlayer(aggregate, viewerPlayerId);
  const submittedPlayerIds = aggregate.window.requiredPlayers
    .filter((entry) => finalSubmissionForPlayer(aggregate, entry.playerId) !== undefined)
    .map((entry) => entry.playerId);

  return {
    ok: true,
    value: {
      battleId: aggregate.window.battleId,
      battleVersion: aggregate.window.battleVersion,
      turnNumber: aggregate.window.turnNumber,
      status: aggregate.window.status,
      deadlineAt: aggregate.window.deadlineAt,
      submittedPlayerIds,
      ownSubmission:
        own === undefined
          ? null
          : {
              submissionRevision: own.submissionRevision,
              submittedAt: own.submittedAt,
              action: structuredClone(own.action),
            },
    },
  };
}

export function commitTurnWindow(
  aggregate: TurnWindowAggregate,
  input: CommitTurnWindowInput,
): TurnWindowResult<CommitTurnWindowOutput> {
  if (
    !isNonNegativeSafeInteger(input.resolvedBattleVersion) ||
    !uuid.safeParse(input.correlationId).success ||
    !isValidDate(input.committedAt)
  ) {
    return failure("TURN_WINDOW_INVALID", "Commit identity or timestamp is invalid");
  }

  if (aggregate.window.status === "COMMITTED") {
    if (
      aggregate.window.resolvedBattleVersion === input.resolvedBattleVersion &&
      aggregate.window.resolutionCorrelationId === input.correlationId
    ) {
      return { ok: true, value: { aggregate: cloneAggregate(aggregate), replayed: true } };
    }
    return failure(
      "TURN_WINDOW_COMMIT_CONFLICT",
      "Turn window was already committed with a different resolution identity",
    );
  }

  if (aggregate.window.status !== "LOCKED") {
    return failure("TURN_WINDOW_NOT_LOCKED", "Only a locked turn window can be committed");
  }
  if (!allRequiredPlayersSubmitted(aggregate)) {
    return failure("TURN_WINDOW_INCOMPLETE", "Locked turn window is missing a required submission");
  }

  const submissions = aggregate.submissions.map((entry) =>
    entry.status === "ACTIVE" ? { ...entry, status: "COMMITTED" as const } : structuredClone(entry),
  );
  const window: BattleTurnWindow = {
    ...aggregate.window,
    status: "COMMITTED",
    committedAt: input.committedAt.toISOString(),
    resolutionCorrelationId: input.correlationId,
    resolvedBattleVersion: input.resolvedBattleVersion,
    revision: aggregate.window.revision + 1,
  };

  return {
    ok: true,
    value: { aggregate: { window, submissions }, replayed: false },
  };
}
