import { describe, expect, it } from "vitest";
import { generateWildPokemon } from "../../src/modules/encounter/generation.js";
import type { WildPokemonBuild } from "../../src/modules/encounter/contracts.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";

function wildBuild(): WildPokemonBuild {
  return {
    formId: "form-1",
    speciesId: "species-1",
    type1Id: "type-1",
    type2Id: null,
    baseStats: {
      hp: 45,
      attack: 49,
      defense: 49,
      spAttack: 65,
      spDefense: 65,
      speed: 45,
    },
    abilityIds: ["ability-1"],
    natureIds: ["nature-1"],
    moves: [
      { moveId: "fifth", learnMethod: "LEVEL", learnLevel: 20, maxPp: 10 },
      { moveId: "start", learnMethod: "START", learnLevel: null, maxPp: 25 },
      { moveId: "first", learnMethod: "LEVEL", learnLevel: 1, maxPp: 35 },
      { moveId: "second", learnMethod: "LEVEL", learnLevel: 5, maxPp: 20 },
      { moveId: "third", learnMethod: "LEVEL", learnLevel: 10, maxPp: 15 },
      { moveId: "fourth", learnMethod: "LEVEL", learnLevel: 15, maxPp: 15 },
      { moveId: "machine", learnMethod: "TM", learnLevel: 1, maxPp: 5 },
      { moveId: "future", learnMethod: "LEVEL", learnLevel: 25, maxPp: 5 },
    ],
  };
}

describe("wild Pokémon initial moves use the canonical selector", () => {
  it("ignores machines and future moves, choosing the latest four legal level moves", () => {
    const built = generateWildPokemon(wildBuild(), 20, new DeterministicRandomSource(7));
    expect(built.moves).toEqual([
      { moveId: "second", ppCurrent: 20 },
      { moveId: "third", ppCurrent: 15 },
      { moveId: "fourth", ppCurrent: 15 },
      { moveId: "fifth", ppCurrent: 10 },
    ]);
    expect(built.moves).toHaveLength(4);
  });

  it("treats a later relearn as recent even when input rows are unsorted", () => {
    const base = wildBuild();
    const moves = [
      ...base.moves,
      { moveId: "start", learnMethod: "LEVEL", learnLevel: 18, maxPp: 25 },
    ];
    const built = generateWildPokemon(
      { ...base, moves },
      20,
      new DeterministicRandomSource(7),
    );
    expect(built.moves.map((move) => move.moveId)).toEqual([
      "third",
      "fourth",
      "start",
      "fifth",
    ]);
  });

  it("fails closed when no eligible START/LEVEL move exists", () => {
    const base = wildBuild();
    expect(() =>
      generateWildPokemon(
        {
          ...base,
          moves: [
            { moveId: "future", learnMethod: "LEVEL", learnLevel: 25, maxPp: 5 },
            { moveId: "machine", learnMethod: "TM", learnLevel: null, maxPp: 5 },
          ],
        },
        20,
        new DeterministicRandomSource(7),
      ),
    ).toThrow("Wild Pokemon build has no eligible moves");
  });
});
