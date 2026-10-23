import { describe, expect, it } from "vitest";
import {
  generatePokemonBuild,
  type PokemonGenerationMoveCandidate,
} from "../../src/modules/pokemon/generation.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";

function levelMove(moveId: string, learnLevel: number): PokemonGenerationMoveCandidate {
  return { moveId, maxPp: 20, learnMethod: "LEVEL", learnLevel };
}

function movesAt(
  level: number,
  moves: readonly PokemonGenerationMoveCandidate[],
): readonly string[] {
  return generatePokemonBuild(
    {
      level,
      baseHp: 45,
      abilityIds: ["ability-1"],
      natureIds: ["nature-1"],
      moves,
    },
    new DeterministicRandomSource(1234),
  ).moves.map((move) => move.moveId);
}

describe("generated Pokémon move selection", () => {
  const chronology: readonly PokemonGenerationMoveCandidate[] = [
    { moveId: "start", maxPp: 25, learnMethod: "START", learnLevel: null },
    levelMove("first", 1),
    levelMove("second", 5),
    levelMove("third", 10),
    levelMove("fourth", 15),
    levelMove("fifth", 20),
  ];

  it("uses the latest four eligible moves rather than the oldest four", () => {
    expect(movesAt(20, chronology)).toEqual(["second", "third", "fourth", "fifth"]);
    expect(movesAt(10, chronology)).toEqual(["start", "first", "second", "third"]);
  });

  it("does not choose moves that belong to future levels", () => {
    expect(movesAt(1, chronology)).toEqual(["start", "first"]);
    expect(movesAt(15, chronology)).toEqual(["first", "second", "third", "fourth"]);
  });

  it("deduplicates moves and treats a later relearn as the latest occurrence", () => {
    const repeated: readonly PokemonGenerationMoveCandidate[] = [
      ...chronology.slice(0, 5),
      levelMove("start", 18),
      ...chronology.slice(5),
    ];
    expect(movesAt(20, repeated)).toEqual(["third", "fourth", "start", "fifth"]);
  });

  it("sorts unordered catalog input chronologically before selecting", () => {
    const shuffled = [chronology[5], chronology[2], chronology[0], chronology[4], chronology[1], chronology[3]];
    expect(movesAt(20, shuffled.filter((move): move is PokemonGenerationMoveCandidate => move !== undefined))).toEqual([
      "second",
      "third",
      "fourth",
      "fifth",
    ]);
  });

  it("does not mutate the source catalog and keeps the PP of chosen moves", () => {
    const candidates = [...chronology];
    const generated = generatePokemonBuild(
      {
        level: 5,
        baseHp: 45,
        abilityIds: ["ability-1"],
        natureIds: ["nature-1"],
        moves: candidates,
      },
      new DeterministicRandomSource(1234),
    );
    expect(candidates).toEqual(chronology);
    expect(generated.moves).toEqual([
      { moveId: "start", ppCurrent: 25 },
      { moveId: "first", ppCurrent: 20 },
      { moveId: "second", ppCurrent: 20 },
    ]);
  });

  it("fails closed if a species has no legal starting move", () => {
    expect(() => movesAt(5, [levelMove("unlearned", 10)])).toThrow(
      "Pokemon build has no eligible move",
    );
  });
});
