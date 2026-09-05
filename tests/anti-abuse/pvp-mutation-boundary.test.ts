import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ExternalPvpMutationEndpoint,
  type PvpMutationOwner,
} from "../../src/modules/anti-abuse/external-pvp-endpoint.js";
import type {
  MutationAdmissionRequest,
  MutationAdmissionPort,
  MutationRatePolicy,
} from "../../src/modules/anti-abuse/contracts.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const proofPolicy: MutationRatePolicy = {
  policyKey: "battle.pvp-proof.v1",
  maxEvents: 3,
  windowMs: 60_000,
};

function proofOwner() {
  const calls = { create: 0, accept: 0, start: 0 };
  const owner: PvpMutationOwner = {
    async createChallenge() {
      calls.create += 1;
      return err(appError("ACTION_INVALID", "proof owner"));
    },
    async acceptChallenge() {
      calls.accept += 1;
      return err(appError("ACTION_INVALID", "proof owner"));
    },
    async startEncounter() {
      calls.start += 1;
      return err(appError("ACTION_INVALID", "proof owner"));
    },
  };
  return { owner, calls };
}

describe("PVP external mutation admission boundary", () => {
  it("classifies Create, Accept and Start under the existing BATTLE player surface", async () => {
    const requests: MutationAdmissionRequest[] = [];
    const admission: MutationAdmissionPort = {
      async consume(request) {
        requests.push(request);
        return ok({ allowed: true, replayed: false, retryAfterMs: 0 });
      },
    };
    const proof = proofOwner();
    const endpoint = new ExternalPvpMutationEndpoint(proof.owner, admission, proofPolicy);
    const challengerPlayerId = randomUUID();
    const targetPlayerId = randomUUID();
    const challengeId = randomUUID();

    await endpoint.createChallenge({
      challengerPlayerId,
      targetPlayerId,
      formatKey: "1V1",
      reachPolicy: "SAME_AREA",
      idempotencyKey: "pvp-create-proof",
    });
    await endpoint.acceptChallenge({ challengeId, actorPlayerId: targetPlayerId });
    await endpoint.startEncounter({ challengeId, actorPlayerId: challengerPlayerId });

    expect(proof.calls).toEqual({ create: 1, accept: 1, start: 1 });
    expect(requests).toHaveLength(3);
    expect(
      requests.map(({ subjectKind, subjectId, surface, actionKey, dedupeKey, policy }) => ({
        subjectKind,
        subjectId,
        surface,
        actionKey,
        dedupeKey,
        policy,
      })),
    ).toEqual([
      {
        subjectKind: "PLAYER",
        subjectId: challengerPlayerId,
        surface: "BATTLE",
        actionKey: "pvp.create-challenge",
        dedupeKey: `pvp:create:${challengerPlayerId}:pvp-create-proof`,
        policy: proofPolicy,
      },
      {
        subjectKind: "PLAYER",
        subjectId: targetPlayerId,
        surface: "BATTLE",
        actionKey: "pvp.accept-challenge",
        dedupeKey: `pvp:accept:${targetPlayerId}:${challengeId}`,
        policy: proofPolicy,
      },
      {
        subjectKind: "PLAYER",
        subjectId: challengerPlayerId,
        surface: "BATTLE",
        actionKey: "pvp.start-encounter",
        dedupeKey: `pvp:start:${challengerPlayerId}:${challengeId}`,
        policy: proofPolicy,
      },
    ]);
    for (const request of requests) {
      expect(request.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("blocks every PVP mutation before the owner when BATTLE admission is denied", async () => {
    const admission: MutationAdmissionPort = {
      async consume() {
        return ok({ allowed: false, replayed: false, retryAfterMs: 1500 });
      },
    };
    const proof = proofOwner();
    const endpoint = new ExternalPvpMutationEndpoint(proof.owner, admission, proofPolicy);
    const playerId = randomUUID();
    const challengeId = randomUUID();

    const create = await endpoint.createChallenge({
      challengerPlayerId: playerId,
      targetPlayerId: randomUUID(),
      formatKey: "1V1",
      reachPolicy: "SAME_AREA",
      idempotencyKey: "pvp-create-blocked",
    });
    const accept = await endpoint.acceptChallenge({ challengeId, actorPlayerId: playerId });
    const start = await endpoint.startEncounter({ challengeId, actorPlayerId: playerId });

    for (const result of [create, accept, start]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RATE_LIMITED");
        expect(result.error.details?.retryAfterMs).toBe(1500);
      }
    }
    expect(proof.calls).toEqual({ create: 0, accept: 0, start: 0 });
  });
});
