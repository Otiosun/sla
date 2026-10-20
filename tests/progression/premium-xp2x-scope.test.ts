import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../src/platform/progression/postgres-progression-repository.ts", import.meta.url),
  "utf8",
);

describe("Premium XP2x progression scope", () => {
  it("covers Pokemon XP, trainer battle XP and eligible system rewards", () => {
    const battleStart = source.indexOf("public async applyBattleReward");

    const adjustmentStart = source.indexOf("private async applyPokemonBattleReward", battleStart);

    expect(battleStart).toBeGreaterThanOrEqual(0);
    expect(adjustmentStart).toBeGreaterThan(battleStart);

    const battleSection = source.slice(battleStart, adjustmentStart);

    const adjustmentSection = source.slice(adjustmentStart);

    expect(battleSection.match(/pokemon_battle_xp_multiplier_for/g) ?? []).toHaveLength(1);
    expect(battleSection).toContain("const baseOfferedXp = battlePokemonXp");
    expect(battleSection).toContain("const offeredXp = multiplyEarnedXp(baseOfferedXp, pokemonXpMultiplier);");
    expect(battleSection).toContain("const pokemonResult = await this.applyPokemonBattleReward");
    expect(battleSection).toContain("const trainerResult = await this.applyTrainerBattleReward");
    expect(battleSection).toContain("xpMultiplier: pokemonXpMultiplier");
    expect(adjustmentSection).toContain("eligibleEarnedTrainerAdjustment");
    expect(adjustmentSection).toContain("pokemon_battle_xp_multiplier_for");
    expect(adjustmentSection).toContain("requestedDelta: input.delta");
  });

  it("never expresses a stack above 2x", () => {
    const battleStart = source.indexOf("public async applyBattleReward");

    const adjustmentStart = source.indexOf("private async applyPokemonBattleReward", battleStart);

    const battleSection = source.slice(battleStart, adjustmentStart);

    expect(battleSection).toContain("pokemonXpMultiplier !== 1 && pokemonXpMultiplier !== 2");

    expect(battleSection).not.toContain("pokemonXpMultiplier * pokemonXpMultiplier");
  });
});
