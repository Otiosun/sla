import { describe, expect, it } from "vitest";
import {
  compareLevelLearnsets,
  parseVersionedLevelLearnset,
} from "../../src/modules/catalog/versioned-learnset-source.js";

const sample = {
  name: "bulbasaur",
  moves: [
    { move: { name: "tackle" }, version_group_details: [
      { level_learned_at: 1, move_learn_method: { name: "level-up" }, version_group: { name: "scarlet-violet" } },
      { level_learned_at: 1, move_learn_method: { name: "level-up" }, version_group: { name: "red-blue" } },
    ] },
    { move: { name: "vine-whip" }, version_group_details: [
      { level_learned_at: 3, move_learn_method: { name: "level-up" }, version_group: { name: "scarlet-violet" } },
      { level_learned_at: 7, move_learn_method: { name: "level-up" }, version_group: { name: "red-blue" } },
    ] },
    { move: { name: "solar-beam" }, version_group_details: [
      { level_learned_at: 0, move_learn_method: { name: "machine" }, version_group: { name: "scarlet-violet" } },
    ] },
  ],
};

describe("version-pinned, reviewable learnset source", () => {
  it("imports only level moves for one game version, never TM or another game", () => {
    expect(parseVersionedLevelLearnset(sample)).toEqual({
      pokemonSlug: "bulbasaur",
      versionGroup: "scarlet-violet",
      moves: [{ moveSlug: "tackle", learnLevel: 1 }, { moveSlug: "vine-whip", learnLevel: 3 }],
    });
  });

  it("highlights the wrong level and never pretends legacy catalog matches", () => {
    const source = parseVersionedLevelLearnset(sample);
    expect(compareLevelLearnsets(source, [
      { moveSlug: "tackle", learnLevel: 1 },
      { moveSlug: "vine-whip", learnLevel: 7 },
    ])).toEqual([{ moveSlug: "vine-whip", sourceLevel: 3, catalogLevel: 7 }]);
  });

  it("fails closed if a Pokémon does not exist in that version group", () => {
    expect(() => parseVersionedLevelLearnset({ name: "missingno", moves: [] })).toThrow(/No level-up source data/);
    expect(() => parseVersionedLevelLearnset(sample, "legends-arceus")).toThrow(/No level-up source data/);
  });

  it("does not allow conflicts, invalid levels or invalid source payloads", () => {
    const version = { move_learn_method: { name: "level-up" }, version_group: { name: "scarlet-violet" } };
    expect(() => parseVersionedLevelLearnset({
      name: "pikachu", moves: [{
        move: { name: "quick-attack" },
        version_group_details: [{ ...version, level_learned_at: 12 }, { ...version, level_learned_at: 14 }],
      }],
    })).toThrow(/Conflicting learn level/);
    expect(() => parseVersionedLevelLearnset({
      name: "pikachu", moves: [{ move: { name: "quick-attack" },
        version_group_details: [{ ...version, level_learned_at: 101 }] }],
    })).toThrow(/outside levels/);
    expect(() => parseVersionedLevelLearnset({ name: "pikachu", moves: "wrong" })).toThrow();
  });
});
