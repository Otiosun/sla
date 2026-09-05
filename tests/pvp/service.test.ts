import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import type { EncounterSeedProvider } from "../../src/modules/encounter/ports.js";
import type { PvpChallenge } from "../../src/modules/pvp/challenge.js";
import { PvpService } from "../../src/modules/pvp/service.js";

interface FakePlayerContext {
  readonly playerId: string;
  readonly playerActive: boolean;
  readonly onboardingComplete: boolean;
  readonly activeExternalIdentity: boolean;
  readonly areaId: string | null;
  readonly hasEligibleTeamPokemon: boolean;
  readonly activeEncounter: boolean;
  readonly activeBattle: boolean;
}

interface FakeContent {
  readonly contentReleaseId: string;
  readonly rulesetId: string;
}

interface FakeState {
  readonly players: Map<string, FakePlayerContext>;
  readonly challenges: Map<string, PvpChallenge>;
  readonly encounters: string[];
  content: FakeContent | null;
  pinnedContentAvailable: boolean;
  lockedPlayers: readonly string[];
}

function eligiblePlayer(playerId: string, areaId: string): FakePlayerContext {
  return {
    playerId,
    playerActive: true,
    onboardingComplete: true,
    activeExternalIdentity: true,
    areaId,
    hasEligibleTeamPokemon: true,
    activeEncounter: false,
    activeBattle: false,
  };
}

function fakeRepository(state: FakeState) {
  const transaction = {
    playerContexts: async (playerIds: readonly string[], lock = false) => {
      const sorted = [...playerIds].sort();
      if (lock) state.lockedPlayers = sorted;
      return sorted.flatMap((playerId) => {
        const context = state.players.get(playerId);
        return context === undefined ? [] : [context];
      });
    },
    activeContent: async () => state.content,
    pinnedContentAvailable: async () => state.pinnedContentAvailable,
    challengeById: async (challengeId: string) => state.challenges.get(challengeId) ?? null,
    challengeByCreationKey: async (challengerPlayerId: string, creationKey: string) =>
      [...state.challenges.values()].find(
        (challenge) =>
          challenge.challengerPlayerId === challengerPlayerId &&
          challenge.creationIdempotencyKey === creationKey,
      ) ?? null,
    insertChallenge: async (challenge: PvpChallenge) => {
      if (state.challenges.has(challenge.id)) return false;
      state.challenges.set(challenge.id, challenge);
      return true;
    },
    replaceChallenge: async (input: {
      readonly expectedRevision: number;
      readonly next: PvpChallenge;
    }) => {
      const current = state.challenges.get(input.next.id);
      if (current === undefined || current.revision !== input.expectedRevision) return false;
      state.challenges.set(input.next.id, input.next);
      return true;
    },
    insertAcceptedEncounter: async (input: { readonly challenge: PvpChallenge }) => {
      if (input.challenge.encounterId === null) throw new Error("missing encounter id");
      state.encounters.push(input.challenge.encounterId);
    },
  };
  return {
    transaction: async <T>(work: (tx: typeof transaction) => Promise<T>): Promise<T> =>
      work(transaction),
    read: async <T>(work: (tx: typeof transaction) => Promise<T>): Promise<T> => work(transaction),
  };
}

function seedProvider(): EncounterSeedProvider {
  return {
    create: () => ({
      seed: new Uint8Array(32).fill(1),
      envelope: {
        ciphertext: new Uint8Array(32).fill(2),
        iv: new Uint8Array(12).fill(3),
        authTag: new Uint8Array(16).fill(4),
        keyVersion: 1,
      },
    }),
  };
}

function harness() {
  const challengerPlayerId = randomUUID();
  const targetPlayerId = randomUUID();
  const areaId = randomUUID();
  const state: FakeState = {
    players: new Map([
      [challengerPlayerId, eligiblePlayer(challengerPlayerId, areaId)],
      [targetPlayerId, eligiblePlayer(targetPlayerId, areaId)],
    ]),
    challenges: new Map(),
    encounters: [],
    content: {
      contentReleaseId: randomUUID(),
      rulesetId: randomUUID(),
    },
    pinnedContentAvailable: true,
    lockedPlayers: [],
  };
  const clock = new ManualClock(new Date("2026-08-31T12:00:00.000Z"));
  const service = new PvpService(
    fakeRepository(state) as never,
    seedProvider(),
    clock,
    { enabled: true, reason: null },
    { challengeTtlMs: 5 * 60_000 },
  );
  return { service, state, clock, challengerPlayerId, targetPlayerId, areaId };
}

function createInput(challengerPlayerId: string, targetPlayerId: string, idempotencyKey = "pvp-1") {
  return {
    challengerPlayerId,
    targetPlayerId,
    formatKey: "1V1" as const,
    reachPolicy: "SAME_AREA" as const,
    idempotencyKey,
  };
}

describe("PvpService Create / Accept", () => {
  it("pins SAME_AREA content and TTL, locks players deterministically, and replays exact Create", async () => {
    const { service, state, challengerPlayerId, targetPlayerId, areaId } = harness();
    const input = createInput(challengerPlayerId, targetPlayerId);

    const created = await service.createChallenge(input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.replayed).toBe(false);
    expect(created.value.challenge).toMatchObject({
      challengerPlayerId,
      targetPlayerId,
      areaId,
      contentReleaseId: state.content?.contentReleaseId,
      rulesetId: state.content?.rulesetId,
      status: "OPEN",
      expiresAt: "2026-08-31T12:05:00.000Z",
    });
    expect(state.lockedPlayers).toEqual([challengerPlayerId, targetPlayerId].sort());

    const replay = await service.createChallenge(input);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.challenge.id).toBe(created.value.challenge.id);
    expect(state.challenges).toHaveLength(1);
  });

  it("rejects semantic reuse of a Create idempotency key for another target", async () => {
    const { service, state, challengerPlayerId, targetPlayerId, areaId } = harness();
    const first = await service.createChallenge(
      createInput(challengerPlayerId, targetPlayerId, "same-key"),
    );
    expect(first.ok).toBe(true);

    const anotherTarget = randomUUID();
    state.players.set(anotherTarget, eligiblePlayer(anotherTarget, areaId));
    const conflict = await service.createChallenge(
      createInput(challengerPlayerId, anotherTarget, "same-key"),
    );
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("FINGERPRINT_MISMATCH");
    expect(state.challenges).toHaveLength(1);
  });

  it.each([
    ["player-not-active", { playerActive: false }],
    ["onboarding-incomplete", { onboardingComplete: false }],
    ["external-identity-missing", { activeExternalIdentity: false }],
    ["battle-ready-team-missing", { hasEligibleTeamPokemon: false }],
  ] as const)("fails closed when target eligibility is %s", async (reason, patch) => {
    const { service, state, challengerPlayerId, targetPlayerId } = harness();
    const current = state.players.get(targetPlayerId);
    if (current === undefined) throw new Error("target fixture missing");
    state.players.set(targetPlayerId, { ...current, ...patch });

    const result = await service.createChallenge(createInput(challengerPlayerId, targetPlayerId));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLAYER_INELIGIBLE");
    expect(result.error.details?.reason).toBe(reason);
    expect(state.challenges).toHaveLength(0);
  });

  it("requires enabled PVP, SAME_AREA, published active content and no mechanical conflict", async () => {
    const disabled = harness();
    const disabledService = new PvpService(
      fakeRepository(disabled.state) as never,
      seedProvider(),
      disabled.clock,
      { enabled: false, reason: "pvp-disabled" },
      { challengeTtlMs: 300_000 },
    );
    const feature = await disabledService.createChallenge(
      createInput(disabled.challengerPlayerId, disabled.targetPlayerId),
    );
    expect(feature.ok).toBe(false);
    if (!feature.ok) expect(feature.error.code).toBe("FEATURE_UNAVAILABLE");

    const area = harness();
    const target = area.state.players.get(area.targetPlayerId);
    if (target === undefined) throw new Error("target fixture missing");
    area.state.players.set(area.targetPlayerId, { ...target, areaId: randomUUID() });
    const wrongArea = await area.service.createChallenge(
      createInput(area.challengerPlayerId, area.targetPlayerId),
    );
    expect(wrongArea.ok).toBe(false);
    if (!wrongArea.ok) {
      expect(wrongArea.error.code).toBe("ACTION_INVALID");
      expect(wrongArea.error.details?.reason).toBe("pvp-same-area-required");
    }

    const content = harness();
    content.state.content = null;
    const noContent = await content.service.createChallenge(
      createInput(content.challengerPlayerId, content.targetPlayerId),
    );
    expect(noContent.ok).toBe(false);
    if (!noContent.ok) {
      expect(noContent.error.code).toBe("FLOW_BLOCKED");
      expect(noContent.error.details?.reason).toBe("active-content-missing");
    }

    const conflict = harness();
    const challenger = conflict.state.players.get(conflict.challengerPlayerId);
    if (challenger === undefined) throw new Error("challenger fixture missing");
    conflict.state.players.set(conflict.challengerPlayerId, {
      ...challenger,
      activeEncounter: true,
    });
    const busy = await conflict.service.createChallenge(
      createInput(conflict.challengerPlayerId, conflict.targetPlayerId),
    );
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.error.code).toBe("FLOW_BLOCKED");
      expect(busy.error.details?.reason).toBe("active-mechanical-flow");
    }
  });

  it("accepts only as the target, revalidates pinned eligibility, creates one Encounter and replays", async () => {
    const { service, state, challengerPlayerId, targetPlayerId } = harness();
    const created = await service.createChallenge(createInput(challengerPlayerId, targetPlayerId));
    if (!created.ok) throw created.error;

    const forbidden = await service.acceptChallenge({
      challengeId: created.value.challenge.id,
      actorPlayerId: challengerPlayerId,
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe("ACTION_INVALID");
    expect(state.encounters).toHaveLength(0);

    const accepted = await service.acceptChallenge({
      challengeId: created.value.challenge.id,
      actorPlayerId: targetPlayerId,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.replayed).toBe(false);
    expect(accepted.value.challenge.status).toBe("ACCEPTED");
    expect(accepted.value.encounterId).toBe(accepted.value.challenge.encounterId);
    expect(state.encounters).toEqual([accepted.value.encounterId]);

    const replay = await service.acceptChallenge({
      challengeId: created.value.challenge.id,
      actorPlayerId: targetPlayerId,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.encounterId).toBe(accepted.value.encounterId);
    expect(state.encounters).toHaveLength(1);
  });

  it("revalidates both players and pinned release/ruleset at Accept", async () => {
    const roster = harness();
    const created = await roster.service.createChallenge(
      createInput(roster.challengerPlayerId, roster.targetPlayerId),
    );
    if (!created.ok) throw created.error;
    const target = roster.state.players.get(roster.targetPlayerId);
    if (target === undefined) throw new Error("target fixture missing");
    roster.state.players.set(roster.targetPlayerId, {
      ...target,
      hasEligibleTeamPokemon: false,
    });
    const ineligible = await roster.service.acceptChallenge({
      challengeId: created.value.challenge.id,
      actorPlayerId: roster.targetPlayerId,
    });
    expect(ineligible.ok).toBe(false);
    if (!ineligible.ok) {
      expect(ineligible.error.code).toBe("PLAYER_INELIGIBLE");
      expect(ineligible.error.details?.reason).toBe("battle-ready-team-missing");
    }
    expect(roster.state.encounters).toHaveLength(0);

    const pinned = harness();
    const pinnedCreated = await pinned.service.createChallenge(
      createInput(pinned.challengerPlayerId, pinned.targetPlayerId),
    );
    if (!pinnedCreated.ok) throw pinnedCreated.error;
    pinned.state.pinnedContentAvailable = false;
    const stale = await pinned.service.acceptChallenge({
      challengeId: pinnedCreated.value.challenge.id,
      actorPlayerId: pinned.targetPlayerId,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("FLOW_BLOCKED");
      expect(stale.error.details?.reason).toBe("pinned-content-unavailable");
    }
    expect(pinned.state.encounters).toHaveLength(0);
  });

  it("persists EXPIRED on late Accept and creates no Encounter", async () => {
    const { service, state, clock, challengerPlayerId, targetPlayerId } = harness();
    const created = await service.createChallenge(createInput(challengerPlayerId, targetPlayerId));
    if (!created.ok) throw created.error;
    clock.advanceMs(5 * 60_000);

    const result = await service.acceptChallenge({
      challengeId: created.value.challenge.id,
      actorPlayerId: targetPlayerId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FLOW_BLOCKED");
      expect(result.error.details?.reason).toBe("challenge-expired");
    }
    expect(state.challenges.get(created.value.challenge.id)?.status).toBe("EXPIRED");
    expect(state.encounters).toHaveLength(0);
  });
});
