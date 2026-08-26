import { describe, expect, it } from "vitest";
import type { BattleState } from "../../src/modules/battle/contracts.js";
import { BattleRuntimeService } from "../../src/modules/battle/runtime.js";
import { battleState } from "./fixtures.js";

function playerSide(state: BattleState) {
  const side = state.sides.find((entry) => entry.controllerKind === "PLAYER");
  if (side === undefined || side.playerId === null) throw new Error("fixture player side is missing");
  return side;
}

function lostState(): BattleState {
  const state = battleState();
  const player = playerSide(state);
  const opponent = state.sides.find((entry) => entry.sideNo !== player.sideNo);
  if (opponent === undefined) throw new Error("fixture opponent side is missing");
  state.status = "LOST";
  state.version = 3;
  player.result = "LOST";
  opponent.result = "WON";
  return state;
}

describe("BattleRuntimeService", () => {
  it("applies defeat aftermath even when the terminal turn is an idempotent replay", async () => {
    const state = lostState();
    const player = playerSide(state);
    let aftermathCalls = 0;
    const runtime = new BattleRuntimeService(
      {
        async initialize() {
          return { ok: true as const, value: { state, replayed: true } };
        },
        async currentState() {
          return { ok: true as const, value: state };
        },
        async resolvePlayerTurn() {
          return { ok: true as const, value: { state, events: [], replayed: true } };
        },
      },
      {
        async applyDefeat() {
          aftermathCalls += 1;
          return { relocatedPlayerIds: [] };
        },
      },
      {
        async cancel() {
          return { kind: "NOT_ACTIVE" as const, currentState: state };
        },
      },
    );

    const result = await runtime.resolvePlayerTurn({
      battleId: state.battleId,
      playerId: player.playerId,
      expectedVersion: 2,
      idempotencyKey: "replayed-terminal-turn",
      action: {
        type: "FLEE",
        actorParticipantId: player.activeParticipantId,
      },
    });

    expect(result.ok).toBe(true);
    expect(aftermathCalls).toBe(1);
  });

  it("surfaces aftermath failure without hiding the already-resolved terminal state", async () => {
    const state = lostState();
    const player = playerSide(state);
    const runtime = new BattleRuntimeService(
      {
        async initialize() {
          return { ok: true as const, value: { state, replayed: false } };
        },
        async currentState() {
          return { ok: true as const, value: state };
        },
        async resolvePlayerTurn() {
          return { ok: true as const, value: { state, events: [], replayed: false } };
        },
      },
      {
        async applyDefeat() {
          throw new Error("world unavailable");
        },
      },
      {
        async cancel() {
          return { kind: "NOT_ACTIVE" as const, currentState: state };
        },
      },
    );

    const result = await runtime.resolvePlayerTurn({
      battleId: state.battleId,
      playerId: player.playerId,
      expectedVersion: 2,
      idempotencyKey: "terminal-turn",
      action: {
        type: "FLEE",
        actorParticipantId: player.activeParticipantId,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BATTLE_AFTERMATH_FAILED");
    expect(result.error.currentState).toEqual(state);
  });

  it("maps cancellation persistence and repeat cancellation to one terminal state", async () => {
    const active = battleState();
    const cancelled = structuredClone(active);
    cancelled.status = "CANCELLED";
    cancelled.version += 1;
    for (const side of cancelled.sides) side.result = "CANCELLED";
    let calls = 0;
    const runtime = new BattleRuntimeService(
      {
        async initialize() {
          return { ok: true as const, value: { state: active, replayed: false } };
        },
        async currentState() {
          return { ok: true as const, value: active };
        },
        async resolvePlayerTurn() {
          return { ok: true as const, value: { state: active, events: [], replayed: false } };
        },
      },
      {
        async applyDefeat() {
          return { relocatedPlayerIds: [] };
        },
      },
      {
        async cancel() {
          calls += 1;
          return calls === 1
            ? {
                kind: "PERSISTED" as const,
                state: cancelled,
                events: [{ type: "BattleEnded" as const, payload: { status: "CANCELLED" } }],
              }
            : { kind: "REPLAYED" as const, state: cancelled };
        },
      },
    );

    const first = await runtime.cancel({
      battleId: active.battleId,
      expectedVersion: active.version,
      reason: "operator recovery",
    });
    const replay = await runtime.cancel({
      battleId: active.battleId,
      expectedVersion: active.version,
      reason: "operator recovery",
    });

    expect(first.ok && first.value.replayed).toBe(false);
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(replay.ok && replay.value.state).toEqual(cancelled);
  });
});
