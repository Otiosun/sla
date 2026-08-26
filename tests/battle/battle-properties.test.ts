import { describe, expect, it } from "vitest";
import { chooseHeuristicAction } from "../../src/modules/battle/ai.js";
import { resolveTurn } from "../../src/modules/battle/resolver.js";
import { CounterRandomSource } from "../../src/platform/rng/counter-rng.js";
import { TEST_RULES, battleState } from "./fixtures.js";

function rng(seed: number, counter = 0n): CounterRandomSource {
  return new CounterRandomSource(Buffer.alloc(32, seed & 0xff), counter);
}

describe("Battle Engine v1 properties", () => {
  it("replays identical state/actions/seed/counter bit-for-bit across many seeds", () => {
    for (let seed = 0; seed < 256; seed += 1) {
      const left = battleState();
      const right = structuredClone(left);
      const chooser = rng(seed);
      const actions = left.sides
        .map((side) => chooseHeuristicAction(left, side.sideNo, TEST_RULES, chooser))
        .filter((action): action is NonNullable<typeof action> => action !== null);
      const counter = chooser.counter;

      const first = resolveTurn(left, actions, TEST_RULES, rng(seed, counter));
      const second = resolveTurn(right, structuredClone(actions), TEST_RULES, rng(seed, counter));

      expect(second).toEqual(first);
    }
  });

  it("preserves HP, PP and stage bounds and never turns damage into healing", () => {
    for (let seed = 1; seed <= 96; seed += 1) {
      let state = battleState(true);
      let counter = 0n;

      for (let turn = 0; turn < 80 && state.status === "ACTIVE"; turn += 1) {
        const hpBefore = new Map(
          state.combatants.map((combatant) => [combatant.participantId, combatant.currentHp]),
        );
        const chooser = rng(seed, counter);
        const actions = state.sides
          .map((side) => chooseHeuristicAction(state, side.sideNo, TEST_RULES, chooser))
          .filter((action): action is NonNullable<typeof action> => action !== null);
        counter = chooser.counter;

        const resolverRng = rng(seed, counter);
        const resolved = resolveTurn(state, actions, TEST_RULES, resolverRng);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) break;
        state = resolved.value.state;
        counter = resolverRng.counter;

        for (const combatant of state.combatants) {
          expect(combatant.currentHp).toBeGreaterThanOrEqual(0);
          expect(combatant.currentHp).toBeLessThanOrEqual(combatant.maxHp);
          expect(combatant.currentHp).toBeLessThanOrEqual(
            hpBefore.get(combatant.participantId) ?? combatant.currentHp,
          );
          for (const move of combatant.moves) {
            if (move.ppCurrent !== null) {
              expect(move.ppCurrent).toBeGreaterThanOrEqual(0);
              if (move.maxPp !== null) expect(move.ppCurrent).toBeLessThanOrEqual(move.maxPp);
            }
          }
          for (const stage of Object.values(combatant.stages)) {
            expect(stage).toBeGreaterThanOrEqual(-6);
            expect(stage).toBeLessThanOrEqual(6);
          }
        }
      }
    }
  });

  it("fuzzes 5,000 resolved turns without impossible state", () => {
    let resolvedTurns = 0;

    for (let seed = 1; seed <= 50; seed += 1) {
      let state = battleState(true);
      let counter = 0n;

      for (const combatant of state.combatants) {
        combatant.maxHp = 999_999;
        combatant.currentHp = 999_999;
        combatant.majorStatus = null;
        combatant.volatile = { flinch: false, confusionTurns: 0 };
        for (const move of combatant.moves) {
          move.maxPp = 99;
          move.ppCurrent = 99;
          move.effectKey = null;
          move.effectConfig = {};
        }
      }

      for (let turn = 0; turn < 100; turn += 1) {
        const chooser = rng(seed, counter);
        const actions = state.sides
          .map((side) => chooseHeuristicAction(state, side.sideNo, TEST_RULES, chooser))
          .filter((action): action is NonNullable<typeof action> => action !== null);
        counter = chooser.counter;
        expect(actions).toHaveLength(state.sides.length);

        const resolverRng = rng(seed, counter);
        const resolved = resolveTurn(state, actions, TEST_RULES, resolverRng);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) throw new Error(`Fuzz turn ${turn} failed for seed ${seed}`);
        state = resolved.value.state;
        counter = resolverRng.counter;
        resolvedTurns += 1;

        expect(state.status).toBe("ACTIVE");
        for (const combatant of state.combatants) {
          expect(combatant.currentHp).toBeGreaterThan(0);
          expect(combatant.currentHp).toBeLessThanOrEqual(combatant.maxHp);
          for (const stage of Object.values(combatant.stages)) {
            expect(stage).toBeGreaterThanOrEqual(-6);
            expect(stage).toBeLessThanOrEqual(6);
          }
        }
      }
    }

    expect(resolvedTurns).toBe(5_000);
  }, 15_000);
});
