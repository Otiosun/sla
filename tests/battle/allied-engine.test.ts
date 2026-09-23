import { describe, expect, it } from "vitest";
import { chooseHeuristicAction } from "../../src/modules/battle/ai.js";
import { type BattleAction, BattleStateSchema } from "../../src/modules/battle/contracts.js";
import { legalActionsForParticipant } from "../../src/modules/battle/legal.js";
import { requiredActionParticipants, resolveTurn } from "../../src/modules/battle/resolver.js";
import { CounterRandomSource } from "../../src/platform/rng/counter-rng.js";
import { battleState, IDS, playerCombatant, reserveCombatant, TEST_RULES } from "./fixtures.js";

const allyId = "00000000-0000-4000-8000-000000000901";
const allyReserveId = "00000000-0000-4000-8000-000000000902";
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function allied() {
  const state = battleState();
  const side = present(state.sides[0]);
  side.participantIds.push(IDS.p1Reserve, allyId, allyReserveId);
  state.combatants.push(reserveCombatant());
  side.slots = [
    { activeParticipantId: IDS.p1, participantIds: [IDS.p1, IDS.p1Reserve] },
    { activeParticipantId: allyId, participantIds: [allyId, allyReserveId] },
  ];
  state.combatants.push(
    { ...playerCombatant(), participantId: allyId, rosterPosition: 3 },
    { ...playerCombatant(), participantId: allyReserveId, rosterPosition: 4 },
  );
  for (const actor of state.combatants) actor.currentHp = actor.maxHp = 500;
  return state;
}
const rng = () => new CounterRandomSource(Buffer.alloc(32, 4));
const moves = (): BattleAction[] =>
  [IDS.p1, allyId, IDS.p2].map((id) => ({
    type: "USE_MOVE",
    actorParticipantId: id,
    moveSlot: 1,
    targetParticipantId: id === IDS.p2 ? allyId : IDS.p2,
  }));

describe("allied active slots on one battle side", () => {
  it("requires and resolves all three actors without adding a side", () => {
    const state = allied();
    expect(BattleStateSchema.safeParse(state).success).toBe(true);
    expect(requiredActionParticipants(state).map((a) => a.participantId)).toEqual([
      IDS.p1,
      allyId,
      IDS.p2,
    ]);
    expect(resolveTurn(state, moves().slice(1), TEST_RULES, rng()).ok).toBe(false);
    expect(resolveTurn(state, [...moves(), present(moves()[0])], TEST_RULES, rng()).ok).toBe(false);
    const result = resolveTurn(state, moves(), TEST_RULES, rng());
    if (!result.ok) throw result.error;
    expect(result.value.state.sides).toHaveLength(2);
    expect(result.value.events.filter((e) => e.type === "MoveUsed")).toHaveLength(3);
    expect(state.combatants.every((a) => a.currentHp === 500)).toBe(true);
  });

  it("isolates reserves, rejects bench actions and lets AUTO target either ally", () => {
    const state = allied();
    const legal = legalActionsForParticipant(state, allyId, TEST_RULES);
    expect(legal.filter((a) => a.type === "SWITCH")).toEqual([
      { type: "SWITCH", actorParticipantId: allyId, switchToParticipantId: allyReserveId },
    ]);
    expect(legalActionsForParticipant(state, allyReserveId, TEST_RULES)).toEqual([]);
    expect(
      new Set(
        legalActionsForParticipant(state, IDS.p2, TEST_RULES)
          .filter((a) => a.type === "USE_MOVE")
          .map((a) => a.targetParticipantId),
      ),
    ).toEqual(new Set([IDS.p1, allyId]));
    expect(chooseHeuristicAction(state, 1, TEST_RULES, rng(), allyId)?.actorParticipantId).toBe(
      allyId,
    );
  });

  it("forces only the fainted slot to switch and preserves the other active ally", () => {
    const state = allied();
    present(state.combatants.find((a) => a.participantId === allyId)).currentHp = 0;
    expect(requiredActionParticipants(state).map((a) => a.participantId)).toEqual([allyId]);
    const result = resolveTurn(
      state,
      [{ type: "SWITCH", actorParticipantId: allyId, switchToParticipantId: allyReserveId }],
      TEST_RULES,
      rng(),
    );
    if (!result.ok) throw result.error;
    expect(result.value.state.sides[0]?.activeParticipantId).toBe(IDS.p1);
    expect(result.value.state.sides[0]?.slots?.[1]?.activeParticipantId).toBe(allyReserveId);
    expect(BattleStateSchema.safeParse(result.value.state).success).toBe(true);
    expect(requiredActionParticipants(result.value.state).map((a) => a.participantId)).toEqual([
      IDS.p1,
      allyReserveId,
      IDS.p2,
    ]);
    present(state.combatants.find((a) => a.participantId === allyReserveId)).currentHp = 0;
    expect(requiredActionParticipants(state).map((a) => a.participantId)).toEqual([IDS.p1, IDS.p2]);
  });

  it("applies residual damage to both active allies but never their reserves", () => {
    const state = allied();
    for (const actor of state.combatants.filter((a) => a.sideNo === 1))
      actor.majorStatus = { key: "POISON", counter: null };
    const result = resolveTurn(state, moves(), TEST_RULES, rng());
    if (!result.ok) throw result.error;
    expect(
      result.value.events
        .filter((e) => e.type === "DamageApplied" && e.payload.source === "POISON")
        .map((e) => e.payload.participantId),
    ).toEqual([IDS.p1, allyId]);
  });

  it("rejects overlapping, missing, foreign or inconsistent slot rosters", () => {
    for (const mutate of [
      (s: ReturnType<typeof allied>) =>
        present(present(s.sides[0]).slots?.[1]).participantIds.push(IDS.p1Reserve),
      (s: ReturnType<typeof allied>) =>
        present(present(s.sides[0]).slots?.[1]).participantIds.pop(),
      (s: ReturnType<typeof allied>) => {
        present(present(s.sides[0]).slots?.[1]).activeParticipantId = IDS.p2;
      },
      (s: ReturnType<typeof allied>) => {
        present(s.sides[0]).activeParticipantId = allyId;
      },
      (s: ReturnType<typeof allied>) => {
        const side = present(s.sides[0]);
        side.participantIds.push(IDS.p2);
        present(side.slots?.[1]).participantIds.push(IDS.p2);
      },
    ]) {
      const state = allied();
      mutate(state);
      expect(BattleStateSchema.safeParse(state).success).toBe(false);
      const random = rng();
      expect(resolveTurn(state, moves(), TEST_RULES, random).ok).toBe(false);
      expect(random.counter).toBe(0n);
    }
  });
});
