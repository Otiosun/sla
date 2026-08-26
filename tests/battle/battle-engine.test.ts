import { describe, expect, it } from "vitest";
import { CounterRandomSource } from "../../src/platform/rng/counter-rng.js";
import { computeDamage } from "../../src/modules/battle/damage.js";
import { legalActionsForSide } from "../../src/modules/battle/legal.js";
import { resolveTurn } from "../../src/modules/battle/resolver.js";
import { calculateDerivedStats, effectiveAccuracyPercent } from "../../src/modules/battle/stats.js";
import { BattleActionSchema } from "../../src/modules/battle/contracts.js";
import { IDS, TEST_RULES, battleState, playerCombatant, wildCombatant } from "./fixtures.js";

const rng = (byte: number) => new CounterRandomSource(Buffer.alloc(32, byte));

describe("Battle Engine v1 pure resolver", () => {
  it("validates explicit battle action schemas", () => {
    expect(
      BattleActionSchema.safeParse({
        type: "USE_MOVE",
        actorParticipantId: IDS.p1,
        moveSlot: 1,
        targetParticipantId: IDS.p2,
      }).success,
    ).toBe(true);
    expect(
      BattleActionSchema.safeParse({ type: "EXECUTE_SQL", actorParticipantId: IDS.p1 }).success,
    ).toBe(false);
  });

  it("calculates six derived stats from base, level, IV and Nature", () => {
    const neutral = playerCombatant();
    const neutralStats = calculateDerivedStats(neutral, TEST_RULES);
    const adamant = structuredClone(neutral);
    adamant.nature.increasedStat = "ATTACK";
    adamant.nature.decreasedStat = "SP_ATTACK";
    const adamantStats = calculateDerivedStats(adamant, TEST_RULES);
    expect(neutralStats.hp).toBe(neutral.maxHp);
    expect(adamantStats.attack).toBeGreaterThan(neutralStats.attack);
    expect(adamantStats.spAttack).toBeLessThan(neutralStats.spAttack);
    expect(Object.keys(neutralStats).sort()).toEqual(
      ["attack", "defense", "hp", "spAttack", "spDefense", "speed"].sort(),
    );
  });

  it("applies accuracy/evasion stages without exceeding 0..100%", () => {
    const base = battleState();
    const attacker = base.combatants[0];
    const defender = base.combatants[1];
    if (attacker === undefined || defender === undefined) throw new Error("fixture incomplete");
    attacker.stages.accuracy = -6;
    defender.stages.evasion = 6;
    const reduced = effectiveAccuracyPercent(100, attacker.stages, defender.stages, true);
    expect(reduced).toBeGreaterThan(0);
    expect(reduced).toBeLessThan(20);
    expect(effectiveAccuracyPercent(100, attacker.stages, defender.stages, false)).toBe(100);
  });

  it("resolves move priority before Speed and consumes PP", () => {
    const state = battleState();
    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 3, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const firstMove = result.value.events.find((entry) => entry.type === "MoveUsed");
    expect(firstMove?.payload.participantId).toBe(IDS.p1);
    expect(
      result.value.state.combatants.find((entry) => entry.participantId === IDS.p1)?.moves[2]
        ?.ppCurrent,
    ).toBe(29);
  });

  it("replays a speed tie identically from the same seed and counter", () => {
    const stateA = battleState();
    const stateB = battleState();
    const p1A = stateA.combatants.find((entry) => entry.participantId === IDS.p1);
    const p2A = stateA.combatants.find((entry) => entry.participantId === IDS.p2);
    const p1B = stateB.combatants.find((entry) => entry.participantId === IDS.p1);
    const p2B = stateB.combatants.find((entry) => entry.participantId === IDS.p2);
    if (p1A === undefined || p2A === undefined || p1B === undefined || p2B === undefined)
      throw new Error("fixture incomplete");
    p1A.baseStats.speed = p2A.baseStats.speed;
    p1A.ivs.speed = p2A.ivs.speed;
    p1A.level = p2A.level;
    p1B.baseStats.speed = p2B.baseStats.speed;
    p1B.ivs.speed = p2B.ivs.speed;
    p1B.level = p2B.level;
    const actions = [
      {
        type: "USE_MOVE" as const,
        actorParticipantId: IDS.p1,
        moveSlot: 1,
        targetParticipantId: IDS.p2,
      },
      {
        type: "USE_MOVE" as const,
        actorParticipantId: IDS.p2,
        moveSlot: 1,
        targetParticipantId: IDS.p1,
      },
    ];
    const first = resolveTurn(stateA, actions, TEST_RULES, rng(7));
    const second = resolveTurn(stateB, actions, TEST_RULES, rng(7));
    expect(first).toEqual(second);
  });

  it("computes STAB, type effectiveness, immunity and critical multipliers deterministically", () => {
    const attacker = playerCombatant();
    const defender = wildCombatant();
    defender.type1Id = IDS.grass;
    defender.type2Id = null;
    const ember = attacker.moves[1];
    if (ember === undefined) throw new Error("fixture incomplete");
    const superEffective = computeDamage(attacker, defender, ember, TEST_RULES, rng(2));
    expect(superEffective.stabApplied).toBe(true);
    expect(superEffective.effectivenessBasisPoints).toBe(20_000);
    expect(superEffective.damage).toBeGreaterThan(0);

    const ghost = structuredClone(defender);
    ghost.type1Id = IDS.ghost;
    const tackle = attacker.moves[0];
    if (tackle === undefined) throw new Error("fixture incomplete");
    const immune = computeDamage(attacker, ghost, tackle, TEST_RULES, rng(2));
    expect(immune.effectivenessBasisPoints).toBe(0);
    expect(immune.damage).toBe(0);

    const criticalRules = { ...TEST_RULES, criticalChanceBasisPoints: 10_000 };
    const crit = computeDamage(attacker, defender, ember, criticalRules, rng(2));
    expect(crit.critical).toBe(true);
    expect(crit.damage).toBeGreaterThan(superEffective.damage);
  });

  it("never lets damage push HP below zero and emits Fainted exactly once", () => {
    const state = battleState();
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (player === undefined || wild === undefined) throw new Error("fixture incomplete");
    const quick = player.moves[2];
    if (quick === undefined) throw new Error("fixture incomplete");
    quick.power = 999;
    wild.currentHp = 1;
    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 3, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(3),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updatedWild = result.value.state.combatants.find(
      (entry) => entry.participantId === IDS.p2,
    );
    expect(updatedWild?.currentHp).toBe(0);
    expect(result.value.events.filter((entry) => entry.type === "Fainted")).toHaveLength(1);
    expect(result.value.state.status).toBe("WON");
  });

  it("resolves a forced switch even though the outgoing active combatant is fainted", () => {
    const state = battleState(true);
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    if (player === undefined) throw new Error("fixture incomplete");
    player.currentHp = 0;
    const legal = legalActionsForSide(state, 1, TEST_RULES);
    expect(legal).toEqual([
      { type: "SWITCH", actorParticipantId: IDS.p1, switchToParticipantId: IDS.p1Reserve },
    ]);
    const result = resolveTurn(state, legal, TEST_RULES, rng(4));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.sides[0]?.activeParticipantId).toBe(IDS.p1Reserve);
    expect(result.value.events.some((entry) => entry.type === "Switched")).toBe(true);
  });

  it("does not mutate source state when an action is illegal", () => {
    const state = battleState();
    const before = structuredClone(state);
    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 4, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 1, targetParticipantId: IDS.p2 },
      ],
      TEST_RULES,
      rng(5),
    );
    expect(result.ok).toBe(false);
    expect(state).toEqual(before);
  });
});
