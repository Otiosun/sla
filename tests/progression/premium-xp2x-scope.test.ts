import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../src/platform/progression/postgres-progression-repository.ts", import.meta.url),
  "utf8",
);

describe("Premium XP2x scope", () => {
  const battleStart = source.indexOf("public async applyBattleReward");
  const pokemonAdjustStart = source.indexOf("public async adjustPokemonXp");
  const trainerAdjustStart = source.indexOf("public async adjustTrainerProgress");
  const battleSection = source.slice(battleStart, pokemonAdjustStart);
  const pokemonCorrection = source.slice(pokemonAdjustStart, trainerAdjustStart);
  const trainerAdjustment = source.slice(trainerAdjustStart);

  it("applies Premium multiplier once to earned Pokemon AND trainer battle progression", () => {
    expect(battleStart).toBeGreaterThanOrEqual(0);
    expect(pokemonAdjustStart).toBeGreaterThan(battleStart);
    expect(battleSection.match(/pokemon_battle_xp_multiplier_for/g) ?? []).toHaveLength(1);
    expect(battleSection).toContain("const baseOfferedXp = battlePokemonXp");
    expect(battleSection).toContain(
      "const offeredXp = multiplyEarnedXp(baseOfferedXp, pokemonXpMultiplier);",
    );
    expect(battleSection).toContain("xpMultiplier: pokemonXpMultiplier,");
    expect(battleSection).toMatch(
      /input\.progression\.trainer\.pointsPerWonBattle,\s*input\.xpMultiplier/,
    );
    expect(battleSection).not.toContain("pokemonXpMultiplier * pokemonXpMultiplier");
  });

  it("keeps corrective Pokemon XP edits outside Premium scaling", () => {
    expect(pokemonAdjustStart).toBeGreaterThan(battleStart);
    expect(trainerAdjustStart).toBeGreaterThan(pokemonAdjustStart);
    expect(pokemonCorrection).not.toContain("pokemon_battle_xp_multiplier_for");
  });

  it("separates earned trainer gifts from corrective admin adjustments", () => {
    expect(trainerAdjustment).toContain("eligibleEarnedTrainerAdjustment");
    expect(trainerAdjustment).toContain("input.metadata.actorType");
    expect(trainerAdjustment).toContain("input.metadata.sourceType");
    expect(trainerAdjustment).toContain("appliedDelta = multiplyEarnedXp(input.delta, multiplier)");
    expect(trainerAdjustment).toContain("requestedDelta: input.delta");
  });
});
