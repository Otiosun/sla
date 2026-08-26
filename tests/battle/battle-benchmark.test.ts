import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { chooseHeuristicAction } from "../../src/modules/battle/ai.js";
import { resolveTurn } from "../../src/modules/battle/resolver.js";
import { CounterRandomSource } from "../../src/platform/rng/counter-rng.js";
import { TEST_RULES, battleState } from "./fixtures.js";

describe("Battle Engine resolver benchmark", () => {
  it("measures pure resolver throughput without DB or UI", () => {
    const iterations = 1_000;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const state = battleState();
      const rng = new CounterRandomSource(Buffer.alloc(32, index % 251));
      const actions = state.sides
        .map((side) => chooseHeuristicAction(state, side.sideNo, TEST_RULES, rng))
        .filter((action): action is NonNullable<typeof action> => action !== null);
      const result = resolveTurn(state, actions, TEST_RULES, rng);
      expect(result.ok).toBe(true);
    }
    const elapsedMs = performance.now() - started;
    expect(Number.isFinite(elapsedMs)).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
