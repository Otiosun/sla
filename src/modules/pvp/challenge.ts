import { createHash } from "node:crypto";
import { z } from "zod";
import { createIdempotencyKey, parseIdempotencyScope } from "../../shared-kernel/idempotency.js";

const challengeCreateScopeResult = parseIdempotencyScope("pvp.challenge.create");
if (!challengeCreateScopeResult.ok) {
  throw new Error("Canonical PVP challenge idempotency scope is invalid");
}
const PVP_CHALLENGE_CREATE_SCOPE = challengeCreateScopeResult.value;

const uuid = z.string().uuid();

export type PvpChallengeStatus =
  | "OPEN"
  | "ACCEPTED"
  | "DECLINED"
  | "CANCELLED"
  | "EXPIRED"
  | "STARTED";

export type PvpFormatKey = "1V1";
export type PvpReachPolicy = "SAME_AREA";

export interface PvpChallenge {
  readonly id: string;
  readonly challengerPlayerId: string;
  readonly targetPlayerId: string;
  readonly status: PvpChallengeStatus;
  readonly formatKey: PvpFormatKey;
  readonly reachPolicy: PvpReachPolicy;
  readonly areaId: string;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly creationIdempotencyKey: string;
  readonly requestFingerprint: string;
  readonly encounterId: string | null;
  readonly battleId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly startedAt: string | null;
  readonly closedAt: string | null;
}

export interface CreatePvpChallengeInput {
  readonly id: string;
  readonly challengerPlayerId: string;
  readonly targetPlayerId: string;
  readonly formatKey: PvpFormatKey;
  readonly reachPolicy: PvpReachPolicy;
  readonly areaId: string;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly creationIdempotencyKey: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface AcceptPvpChallengeInput {
  readonly actorPlayerId: string;
  readonly encounterId: string;
  readonly acceptedAt: Date;
}

export interface ClosePvpChallengeInput {
  readonly actorPlayerId: string;
  readonly closedAt: Date;
}

export type PvpChallengeErrorCode =
  | "PVP_CHALLENGE_INVALID"
  | "PVP_CHALLENGE_SELF_TARGET"
  | "PVP_CHALLENGE_IDEMPOTENCY_CONFLICT"
  | "PVP_CHALLENGE_ACTOR_FORBIDDEN"
  | "PVP_CHALLENGE_NOT_OPEN"
  | "PVP_CHALLENGE_NOT_EXPIRED"
  | "PVP_CHALLENGE_EXPIRED";

export interface PvpChallengeError {
  readonly code: PvpChallengeErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type PvpChallengeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PvpChallengeError };

function failure(
  code: PvpChallengeErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PvpChallengeResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function requestFingerprint(input: CreatePvpChallengeInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        challengerPlayerId: input.challengerPlayerId,
        targetPlayerId: input.targetPlayerId,
        formatKey: input.formatKey,
        reachPolicy: input.reachPolicy,
        areaId: input.areaId,
        contentReleaseId: input.contentReleaseId,
        rulesetId: input.rulesetId,
      }),
    )
    .digest("hex");
}

function validateCreateInput(
  input: CreatePvpChallengeInput,
): PvpChallengeResult<{
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}> {
  const ids = [
    input.id,
    input.challengerPlayerId,
    input.targetPlayerId,
    input.areaId,
    input.contentReleaseId,
    input.rulesetId,
  ];
  if (ids.some((value) => !uuid.safeParse(value).success)) {
    return failure("PVP_CHALLENGE_INVALID", "PVP challenge ids must be valid UUIDs");
  }
  if (input.challengerPlayerId === input.targetPlayerId) {
    return failure("PVP_CHALLENGE_SELF_TARGET", "A trainer cannot challenge themselves");
  }
  if (input.formatKey !== "1V1" || input.reachPolicy !== "SAME_AREA") {
    return failure("PVP_CHALLENGE_INVALID", "Unsupported PVP format or reach policy");
  }
  if (!validDate(input.createdAt) || !validDate(input.expiresAt)) {
    return failure("PVP_CHALLENGE_INVALID", "Challenge timestamps must be valid dates");
  }
  if (input.expiresAt.getTime() <= input.createdAt.getTime()) {
    return failure("PVP_CHALLENGE_INVALID", "Challenge expiry must be after creation");
  }

  const idempotency = createIdempotencyKey(
    PVP_CHALLENGE_CREATE_SCOPE,
    input.creationIdempotencyKey,
  );
  if (!idempotency.ok) {
    return failure(
      "PVP_CHALLENGE_INVALID",
      idempotency.error.message,
      idempotency.error.details,
    );
  }

  return {
    ok: true,
    value: {
      idempotencyKey: idempotency.value.storageKey,
      fingerprint: requestFingerprint(input),
    },
  };
}

export function createPvpChallenge(
  input: CreatePvpChallengeInput,
): PvpChallengeResult<PvpChallenge> {
  const validated = validateCreateInput(input);
  if (!validated.ok) return validated;

  const createdAt = input.createdAt.toISOString();
  return {
    ok: true,
    value: {
      id: input.id,
      challengerPlayerId: input.challengerPlayerId,
      targetPlayerId: input.targetPlayerId,
      status: "OPEN",
      formatKey: input.formatKey,
      reachPolicy: input.reachPolicy,
      areaId: input.areaId,
      contentReleaseId: input.contentReleaseId,
      rulesetId: input.rulesetId,
      creationIdempotencyKey: validated.value.idempotencyKey,
      requestFingerprint: validated.value.fingerprint,
      encounterId: null,
      battleId: null,
      revision: 0,
      createdAt,
      updatedAt: createdAt,
      expiresAt: input.expiresAt.toISOString(),
      acceptedAt: null,
      startedAt: null,
      closedAt: null,
    },
  };
}

export function matchesPvpChallengeCreateRequest(
  existing: PvpChallenge,
  input: CreatePvpChallengeInput,
): PvpChallengeResult<boolean> {
  const validated = validateCreateInput(input);
  if (!validated.ok) return validated;
  if (existing.creationIdempotencyKey !== validated.value.idempotencyKey) {
    return { ok: true, value: false };
  }
  if (existing.requestFingerprint !== validated.value.fingerprint) {
    return failure(
      "PVP_CHALLENGE_IDEMPOTENCY_CONFLICT",
      "Challenge idempotency key was already used for a different request",
    );
  }
  return { ok: true, value: true };
}

export function acceptPvpChallenge(
  challenge: PvpChallenge,
  input: AcceptPvpChallengeInput,
): PvpChallengeResult<PvpChallenge> {
  if (challenge.status !== "OPEN") {
    return failure("PVP_CHALLENGE_NOT_OPEN", "Only an open challenge can be accepted");
  }
  if (input.actorPlayerId !== challenge.targetPlayerId) {
    return failure("PVP_CHALLENGE_ACTOR_FORBIDDEN", "Only the target trainer can accept");
  }
  if (!uuid.safeParse(input.encounterId).success || !validDate(input.acceptedAt)) {
    return failure("PVP_CHALLENGE_INVALID", "Acceptance identity or timestamp is invalid");
  }
  if (input.acceptedAt.getTime() >= Date.parse(challenge.expiresAt)) {
    return failure("PVP_CHALLENGE_EXPIRED", "Challenge expired before acceptance");
  }
  const acceptedAt = input.acceptedAt.toISOString();
  return {
    ok: true,
    value: {
      ...challenge,
      status: "ACCEPTED",
      encounterId: input.encounterId,
      acceptedAt,
      updatedAt: acceptedAt,
      revision: challenge.revision + 1,
    },
  };
}

export function declinePvpChallenge(
  challenge: PvpChallenge,
  input: ClosePvpChallengeInput,
): PvpChallengeResult<PvpChallenge> {
  if (challenge.status !== "OPEN") {
    return failure("PVP_CHALLENGE_NOT_OPEN", "Only an open challenge can be declined");
  }
  if (input.actorPlayerId !== challenge.targetPlayerId) {
    return failure("PVP_CHALLENGE_ACTOR_FORBIDDEN", "Only the target trainer can decline");
  }
  return closeOpenChallenge(challenge, "DECLINED", input.closedAt);
}

export function cancelPvpChallenge(
  challenge: PvpChallenge,
  input: ClosePvpChallengeInput,
): PvpChallengeResult<PvpChallenge> {
  if (challenge.status !== "OPEN") {
    return failure("PVP_CHALLENGE_NOT_OPEN", "Only an open challenge can be cancelled");
  }
  if (input.actorPlayerId !== challenge.challengerPlayerId) {
    return failure("PVP_CHALLENGE_ACTOR_FORBIDDEN", "Only the challenger can cancel");
  }
  return closeOpenChallenge(challenge, "CANCELLED", input.closedAt);
}

export function expirePvpChallenge(
  challenge: PvpChallenge,
  now: Date,
): PvpChallengeResult<PvpChallenge> {
  if (challenge.status !== "OPEN") {
    return failure("PVP_CHALLENGE_NOT_OPEN", "Only an open challenge can expire");
  }
  if (!validDate(now)) {
    return failure("PVP_CHALLENGE_INVALID", "Expiry timestamp is invalid");
  }
  if (now.getTime() < Date.parse(challenge.expiresAt)) {
    return failure("PVP_CHALLENGE_NOT_EXPIRED", "Challenge expiry has not been reached");
  }
  return closeOpenChallenge(challenge, "EXPIRED", now);
}

function closeOpenChallenge(
  challenge: PvpChallenge,
  status: "DECLINED" | "CANCELLED" | "EXPIRED",
  closedAt: Date,
): PvpChallengeResult<PvpChallenge> {
  if (!validDate(closedAt)) {
    return failure("PVP_CHALLENGE_INVALID", "Challenge close timestamp is invalid");
  }
  const timestamp = closedAt.toISOString();
  return {
    ok: true,
    value: {
      ...challenge,
      status,
      closedAt: timestamp,
      updatedAt: timestamp,
      revision: challenge.revision + 1,
    },
  };
}
