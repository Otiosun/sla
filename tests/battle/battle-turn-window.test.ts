import { describe, expect, it } from "vitest";
import type { BattleAction } from "../../src/modules/battle/contracts.js";
import {
  commitTurnWindow,
  createTurnWindow,
  getTurnWindowView,
  submitTurnAction,
  type TurnWindowAggregate,
} from "../../src/modules/battle/turn-window.js";

const IDS = {
  window: "00000000-0000-4000-8000-000000000001",
  battle: "00000000-0000-4000-8000-000000000002",
  playerA: "00000000-0000-4000-8000-000000000003",
  playerB: "00000000-0000-4000-8000-000000000004",
  actorA: "00000000-0000-4000-8000-000000000005",
  actorB: "00000000-0000-4000-8000-000000000006",
  targetA: "00000000-0000-4000-8000-000000000007",
  targetB: "00000000-0000-4000-8000-000000000008",
  submissionA1: "00000000-0000-4000-8000-000000000009",
  submissionA2: "00000000-0000-4000-8000-00000000000a",
  submissionB: "00000000-0000-4000-8000-00000000000b",
  correlation: "00000000-0000-4000-8000-00000000000c",
} as const;

const openedAt = new Date("2026-08-31T12:00:00.000Z");
const deadlineAt = new Date("2026-08-31T12:01:00.000Z");

function actionA(moveSlot = 1): BattleAction {
  return {
    type: "USE_MOVE",
    actorParticipantId: IDS.actorA,
    moveSlot,
    targetParticipantId: IDS.targetB,
  };
}

function actionB(): BattleAction {
  return {
    type: "USE_MOVE",
    actorParticipantId: IDS.actorB,
    moveSlot: 2,
    targetParticipantId: IDS.targetA,
  };
}

function aggregate(): TurnWindowAggregate {
  const created = createTurnWindow({
    id: IDS.window,
    battleId: IDS.battle,
    battleVersion: 7,
    turnNumber: 4,
    openedAt,
    deadlineAt,
    requiredPlayers: [
      { playerId: IDS.playerA, sideNo: 1 },
      { playerId: IDS.playerB, sideNo: 2 },
    ],
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("PVP Battle TurnWindow", () => {
  it("keeps the first valid human submission COLLECTING and hidden from the opponent", () => {
    const initial = aggregate();
    const submitted = submitTurnAction(initial, {
      id: IDS.submissionA1,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-turn-7",
      action: actionA(),
      submittedAt: new Date("2026-08-31T12:00:10.000Z"),
    });

    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.aggregate.window.status).toBe("COLLECTING");
    expect(submitted.value.replayed).toBe(false);

    const opponentView = getTurnWindowView(submitted.value.aggregate, IDS.playerB);
    expect(opponentView.ok).toBe(true);
    if (!opponentView.ok) return;
    expect(opponentView.value.ownSubmission).toBeNull();
    expect(opponentView.value.submittedPlayerIds).toEqual([IDS.playerA]);
    expect(JSON.stringify(opponentView.value)).not.toContain(IDS.actorA);
    expect(JSON.stringify(opponentView.value)).not.toContain("USE_MOVE");
  });

  it("replays the same idempotent submission and rejects reuse with a different payload", () => {
    const initial = aggregate();
    const first = submitTurnAction(initial, {
      id: IDS.submissionA1,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-turn-7",
      action: actionA(),
      submittedAt: new Date("2026-08-31T12:00:10.000Z"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = submitTurnAction(first.value.aggregate, {
      id: IDS.submissionA2,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-turn-7",
      action: actionA(),
      submittedAt: new Date("2026-08-31T12:00:11.000Z"),
    });
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(replay.ok && replay.value.aggregate).toEqual(first.value.aggregate);

    const conflict = submitTurnAction(first.value.aggregate, {
      id: IDS.submissionA2,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-turn-7",
      action: actionA(3),
      submittedAt: new Date("2026-08-31T12:00:12.000Z"),
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("TURN_WINDOW_IDEMPOTENCY_CONFLICT");
  });

  it("supersedes the player's prior action while COLLECTING without consuming the old action", () => {
    const initial = aggregate();
    const first = submitTurnAction(initial, {
      id: IDS.submissionA1,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-turn-7-v1",
      action: actionA(1),
      submittedAt: new Date("2026-08-31T12:00:10.000Z"),
    });
    if (!first.ok) throw new Error(first.error.message);

    const replaced = submitTurnAction(first.value.aggregate, {
      id: IDS.submissionA2,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-turn-7-v2",
      action: actionA(3),
      submittedAt: new Date("2026-08-31T12:00:20.000Z"),
    });

    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const mine = replaced.value.aggregate.submissions.filter(
      (entry) => entry.playerId === IDS.playerA,
    );
    expect(mine).toHaveLength(2);
    expect(mine.map((entry) => entry.status)).toEqual(["SUPERSEDED", "ACTIVE"]);
    expect(mine[1]?.submissionRevision).toBe(2);
  });

  it("locks exactly when the final required human submits and rejects further replacement", () => {
    const initial = aggregate();
    const first = submitTurnAction(initial, {
      id: IDS.submissionA1,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-turn-7",
      action: actionA(),
      submittedAt: new Date("2026-08-31T12:00:10.000Z"),
    });
    if (!first.ok) throw new Error(first.error.message);

    const second = submitTurnAction(first.value.aggregate, {
      id: IDS.submissionB,
      playerId: IDS.playerB,
      sideNo: 2,
      expectedBattleVersion: 7,
      idempotencyKey: "player-b-turn-7",
      action: actionB(),
      submittedAt: new Date("2026-08-31T12:00:15.000Z"),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.aggregate.window.status).toBe("LOCKED");
    expect(second.value.aggregate.window.lockedAt).toBe("2026-08-31T12:00:15.000Z");

    const tooLate = submitTurnAction(second.value.aggregate, {
      id: IDS.submissionA2,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-after-lock",
      action: actionA(4),
      submittedAt: new Date("2026-08-31T12:00:16.000Z"),
    });
    expect(tooLate.ok).toBe(false);
    if (tooLate.ok) return;
    expect(tooLate.error.code).toBe("TURN_WINDOW_NOT_COLLECTING");
  });

  it("fails closed for stale battle versions and expired deadlines", () => {
    const initial = aggregate();

    const stale = submitTurnAction(initial, {
      id: IDS.submissionA1,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 6,
      idempotencyKey: "stale",
      action: actionA(),
      submittedAt: new Date("2026-08-31T12:00:10.000Z"),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("TURN_WINDOW_VERSION_CONFLICT");

    const expired = submitTurnAction(initial, {
      id: IDS.submissionA1,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "expired",
      action: actionA(),
      submittedAt: deadlineAt,
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("TURN_WINDOW_EXPIRED");
  });

  it("commits a locked window once and replays the same commit identity", () => {
    const initial = aggregate();
    const first = submitTurnAction(initial, {
      id: IDS.submissionA1,
      playerId: IDS.playerA,
      sideNo: 1,
      expectedBattleVersion: 7,
      idempotencyKey: "player-a-turn-7",
      action: actionA(),
      submittedAt: new Date("2026-08-31T12:00:10.000Z"),
    });
    if (!first.ok) throw new Error(first.error.message);
    const second = submitTurnAction(first.value.aggregate, {
      id: IDS.submissionB,
      playerId: IDS.playerB,
      sideNo: 2,
      expectedBattleVersion: 7,
      idempotencyKey: "player-b-turn-7",
      action: actionB(),
      submittedAt: new Date("2026-08-31T12:00:15.000Z"),
    });
    if (!second.ok) throw new Error(second.error.message);

    const committed = commitTurnWindow(second.value.aggregate, {
      resolvedBattleVersion: 8,
      correlationId: IDS.correlation,
      committedAt: new Date("2026-08-31T12:00:16.000Z"),
    });
    expect(committed.ok && committed.value.replayed).toBe(false);
    if (!committed.ok) return;
    expect(committed.value.aggregate.window.status).toBe("COMMITTED");
    expect(committed.value.aggregate.submissions.map((entry) => entry.status)).toEqual([
      "COMMITTED",
      "COMMITTED",
    ]);

    const replay = commitTurnWindow(committed.value.aggregate, {
      resolvedBattleVersion: 8,
      correlationId: IDS.correlation,
      committedAt: new Date("2026-08-31T12:00:30.000Z"),
    });
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(replay.ok && replay.value.aggregate).toEqual(committed.value.aggregate);

    const conflictingCommit = commitTurnWindow(committed.value.aggregate, {
      resolvedBattleVersion: 9,
      correlationId: "00000000-0000-4000-8000-00000000000d",
      committedAt: new Date("2026-08-31T12:00:31.000Z"),
    });
    expect(conflictingCommit.ok).toBe(false);
    if (conflictingCommit.ok) return;
    expect(conflictingCommit.error.code).toBe("TURN_WINDOW_COMMIT_CONFLICT");
  });
});
