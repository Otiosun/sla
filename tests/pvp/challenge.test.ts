import { describe, expect, it } from "vitest";
import {
  acceptPvpChallenge,
  cancelPvpChallenge,
  createPvpChallenge,
  declinePvpChallenge,
  expirePvpChallenge,
  matchesPvpChallengeCreateRequest,
} from "../../src/modules/pvp/challenge.js";

const IDS = {
  challenge: "00000000-0000-4000-8000-000000000101",
  challenger: "00000000-0000-4000-8000-000000000102",
  target: "00000000-0000-4000-8000-000000000103",
  stranger: "00000000-0000-4000-8000-000000000104",
  area: "00000000-0000-4000-8000-000000000105",
  release: "00000000-0000-4000-8000-000000000106",
  ruleset: "00000000-0000-4000-8000-000000000107",
  encounter: "00000000-0000-4000-8000-000000000108",
  battle: "00000000-0000-4000-8000-000000000109",
} as const;

const createdAt = new Date("2026-08-31T12:00:00.000Z");
const expiresAt = new Date("2026-08-31T12:05:00.000Z");

function createInput(overrides: Partial<Parameters<typeof createPvpChallenge>[0]> = {}) {
  return {
    id: IDS.challenge,
    challengerPlayerId: IDS.challenger,
    targetPlayerId: IDS.target,
    formatKey: "1V1" as const,
    reachPolicy: "SAME_AREA" as const,
    areaId: IDS.area,
    contentReleaseId: IDS.release,
    rulesetId: IDS.ruleset,
    creationIdempotencyKey: "challenge-create-1",
    createdAt,
    expiresAt,
    ...overrides,
  };
}

function openChallenge() {
  const created = createPvpChallenge(createInput());
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("PVP challenge lifecycle", () => {
  it("creates only a valid 1v1 SAME_AREA challenge and rejects self challenge", () => {
    const created = createPvpChallenge(createInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.status).toBe("OPEN");
    expect(created.value.revision).toBe(0);
    expect(created.value.acceptedAt).toBeNull();
    expect(created.value.encounterId).toBeNull();
    expect(created.value.battleId).toBeNull();

    const self = createPvpChallenge(
      createInput({ targetPlayerId: IDS.challenger }),
    );
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe("PVP_CHALLENGE_SELF_TARGET");
  });

  it("recognizes exact create replay semantics and rejects semantic drift", () => {
    const existing = openChallenge();

    const exact = matchesPvpChallengeCreateRequest(existing, createInput());
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.value).toBe(true);

    const drift = matchesPvpChallengeCreateRequest(
      existing,
      createInput({ targetPlayerId: IDS.stranger }),
    );
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.error.code).toBe("PVP_CHALLENGE_IDEMPOTENCY_CONFLICT");
  });

  it("allows only the target to accept and links one encounter", () => {
    const initial = openChallenge();

    const forbidden = acceptPvpChallenge(initial, {
      actorPlayerId: IDS.stranger,
      encounterId: IDS.encounter,
      acceptedAt: new Date("2026-08-31T12:01:00.000Z"),
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe("PVP_CHALLENGE_ACTOR_FORBIDDEN");

    const accepted = acceptPvpChallenge(initial, {
      actorPlayerId: IDS.target,
      encounterId: IDS.encounter,
      acceptedAt: new Date("2026-08-31T12:01:00.000Z"),
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.status).toBe("ACCEPTED");
    expect(accepted.value.encounterId).toBe(IDS.encounter);
    expect(accepted.value.revision).toBe(1);
  });

  it("expires before acceptance and never resurrects", () => {
    const initial = openChallenge();
    const expired = expirePvpChallenge(initial, expiresAt);
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;
    expect(expired.value.status).toBe("EXPIRED");

    const acceptAfterExpiry = acceptPvpChallenge(expired.value, {
      actorPlayerId: IDS.target,
      encounterId: IDS.encounter,
      acceptedAt: new Date("2026-08-31T12:06:00.000Z"),
    });
    expect(acceptAfterExpiry.ok).toBe(false);
    if (!acceptAfterExpiry.ok) expect(acceptAfterExpiry.error.code).toBe("PVP_CHALLENGE_NOT_OPEN");
  });

  it("supports decline/cancel ownership and keeps terminal states immutable", () => {
    const initial = openChallenge();

    const declined = declinePvpChallenge(initial, {
      actorPlayerId: IDS.target,
      closedAt: new Date("2026-08-31T12:01:00.000Z"),
    });
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    expect(declined.value.status).toBe("DECLINED");

    const cancelDeclined = cancelPvpChallenge(declined.value, {
      actorPlayerId: IDS.challenger,
      closedAt: new Date("2026-08-31T12:01:01.000Z"),
    });
    expect(cancelDeclined.ok).toBe(false);
    if (!cancelDeclined.ok) expect(cancelDeclined.error.code).toBe("PVP_CHALLENGE_NOT_OPEN");

    const cancelled = cancelPvpChallenge(initial, {
      actorPlayerId: IDS.challenger,
      closedAt: new Date("2026-08-31T12:01:00.000Z"),
    });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.value.status).toBe("CANCELLED");
  });
});
