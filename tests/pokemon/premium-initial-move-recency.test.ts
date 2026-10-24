import { describe, expect, it } from "vitest";
import { selectRecentLevelMoves } from "../../src/modules/pokemon/generation.js";

describe("Premium Pokémon starting move chronology", () => {
  const moves = [
    { moveId: "start", learnMethod: "START", learnLevel: null },
    { moveId: "first", learnMethod: "LEVEL", learnLevel: 1 },
    { moveId: "second", learnMethod: "LEVEL", learnLevel: 5 },
    { moveId: "third", learnMethod: "LEVEL", learnLevel: 10 },
    { moveId: "fourth", learnMethod: "LEVEL", learnLevel: 15 },
    { moveId: "fifth", learnMethod: "LEVEL", learnLevel: 20 },
  ] as const;

  it("selects the most recent four eligible moves", () => {
    expect(selectRecentLevelMoves(moves, 20).map((m) => m.moveId)).toEqual([
      "second", "third", "fourth", "fifth",
    ]);
  });

  it("rejects future moves and uses later relearns", () => {
    const unordered = [
      moves[5],
      moves[0],
      moves[4],
      moves[1],
      { moveId: "start", learnMethod: "LEVEL", learnLevel: 18 },
      moves[3],
      moves[2],
    ] as const;
    const result = selectRecentLevelMoves(unordered, 20);
    expect(result.map((m) => m.moveId)).toEqual(["third", "fourth", "start", "fifth"]);
    expect(selectRecentLevelMoves(unordered, 10).map((m) => m.moveId)).toEqual([
      "start", "first", "second", "third",
    ]);
    expect(unordered[0]?.moveId).toBe("fifth");
  });
});
