import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  commitTurnWindow,
  createTurnWindow,
  refreshTurnWindowRequirements,
  submitTurnAction,
} from "../../src/modules/battle/turn-window.js";

const player = randomUUID();
const admin = randomUUID();
const actor = randomUUID();
const wild = randomUUID();
const now = new Date();
const requirements = [
  {
    participantId: actor,
    sideNo: 1,
    kind: "PLAYER" as const,
    playerId: player,
    adminPrincipalId: null,
    revision: 0,
  },
  {
    participantId: wild,
    sideNo: 1,
    kind: "NARRATOR" as const,
    playerId: null,
    adminPrincipalId: admin,
    revision: 2,
  },
];
function window() {
  const result = createTurnWindow({
    id: randomUUID(),
    battleId: randomUUID(),
    battleVersion: 7,
    turnNumber: 4,
    openedAt: now,
    deadlineAt: new Date(now.getTime() + 60000),
    requiredPlayers: [],
    requiredControllers: requirements,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function submission(narrator = false) {
  return {
    id: randomUUID(),
    playerId: narrator ? null : player,
    adminPrincipalId: narrator ? admin : null,
    controllerRevision: narrator ? 2 : 0,
    sideNo: 1,
    expectedBattleVersion: 7,
    idempotencyKey: randomUUID(),
    action: { type: "FLEE" as const, actorParticipantId: narrator ? wild : actor },
    submittedAt: now,
  };
}
describe("controller-scoped TurnWindow", () => {
  it("opens an all-AUTO window locked and commits without synthetic human submissions", () => {
    const created = createTurnWindow({
      ...window().window,
      openedAt: now,
      deadlineAt: new Date(now.getTime() + 60000),
      requiredControllers: [],
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        window: { status: "LOCKED", lockedAt: now.toISOString() },
        submissions: [],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(
      commitTurnWindow(created.value, {
        resolvedBattleVersion: 8,
        correlationId: randomUUID(),
        committedAt: now,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        aggregate: {
          window: { status: "COMMITTED" },
          submissions: [],
        },
      },
    });
    expect(submitTurnAction(created.value, submission()).ok).toBe(false);
  });
  it("locks after the last missing human returns to AUTO, but never removes a submitted controller", () => {
    const first = submitTurnAction(window(), submission());
    if (!first.ok) throw new Error(first.error.message);
    const refreshed = refreshTurnWindowRequirements(
      first.value.aggregate,
      requirements.slice(0, 1),
      now,
    );
    expect(refreshed).toMatchObject({ ok: true, value: { window: { status: "LOCKED" } } });
    expect(
      refreshTurnWindowRequirements(first.value.aggregate, requirements.slice(1), now).ok,
    ).toBe(false);
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    expect(refreshTurnWindowRequirements(refreshed.value, requirements, now).ok).toBe(false);
  });
  it("waits for PLAYER and NARRATOR, locks first actions, and commits", () => {
    const first = submitTurnAction(window(), submission());
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.aggregate.window.status).toBe("COLLECTING");

    const replacement = submitTurnAction(first.value.aggregate, {
      ...submission(),
      id: randomUUID(),
      idempotencyKey: "replacement",
    });
    expect(replacement).toMatchObject({
      ok: false,
      error: { code: "TURN_WINDOW_ALREADY_SUBMITTED" },
    });
    expect(first.value.aggregate.submissions.map((s) => s.status)).toEqual(["ACTIVE"]);

    const input = submission(true);
    const last = submitTurnAction(first.value.aggregate, input);
    if (!last.ok) throw new Error(last.error.message);
    expect(last.value.aggregate.window.status).toBe("LOCKED");
    expect(submitTurnAction(last.value.aggregate, input)).toMatchObject({
      ok: true,
      value: { replayed: true },
    });
    expect(
      commitTurnWindow(last.value.aggregate, {
        resolvedBattleVersion: 8,
        correlationId: randomUUID(),
        committedAt: now,
      }),
    ).toMatchObject({ ok: true, value: { aggregate: { window: { status: "COMMITTED" } } } });
  });
  it("rejects impersonation, stale controller revision and AUTO/unrequired actors", () => {
    const initial = window();
    for (const input of [
      { ...submission(true), adminPrincipalId: randomUUID() },
      { ...submission(true), controllerRevision: 1 },
      { ...submission(), action: { type: "FLEE" as const, actorParticipantId: wild } },
      { ...submission(), action: { type: "FLEE" as const, actorParticipantId: randomUUID() } },
      { ...submission(true), playerId: player },
    ])
      expect(submitTurnAction(initial, input).ok).toBe(false);
  });
  it("requires separate actions for two participants controlled by the same narrator", () => {
    const initial = window();
    const aggregate = {
      ...initial,
      window: {
        ...initial.window,
        requiredControllers: requirements.map((r) => ({
          ...r,
          kind: "NARRATOR" as const,
          playerId: null,
          adminPrincipalId: admin,
          revision: 2,
        })),
      },
    };
    const first = submitTurnAction(aggregate, {
      ...submission(true),
      action: { type: "FLEE", actorParticipantId: actor },
    });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.aggregate.window.status).toBe("COLLECTING");
    const last = submitTurnAction(first.value.aggregate, submission(true));
    if (!last.ok) throw new Error(last.error.message);
    expect(last.value.aggregate.submissions.map((s) => s.status)).toEqual(["ACTIVE", "ACTIVE"]);
    expect(last.value.aggregate.window.status).toBe("LOCKED");
  });
});
