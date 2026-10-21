import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX,
  competitiveSpawnGlobalWeight,
} from "../../src/modules/competitive-spawn/variety-policy.js";
import { COMPETITIVE_SPAWN_LOCAL_BIAS_PERCENT } from "../../src/modules/competitive-spawn/service.js";
import { PostgresCompetitiveSpawnRepository } from "../../src/platform/competitive-spawn/postgres-competitive-spawn-repository.js";

describe("competitive group spawn diversity", () => {
  it("offers common and uncommon Pokemon more often than hard catches", () => {
    expect(competitiveSpawnGlobalWeight(255)).toBe(100);
    expect(competitiveSpawnGlobalWeight(120)).toBe(65);
    expect(competitiveSpawnGlobalWeight(45)).toBe(30);
    expect(competitiveSpawnGlobalWeight(15)).toBe(12);
    expect(competitiveSpawnGlobalWeight(3)).toBe(4);
    expect(competitiveSpawnGlobalWeight(null)).toBe(12);
  });

  it("reserves legendary and mythical species outside casual competitive spawns", () => {
    expect(COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX).toHaveLength(21);
    expect(new Set(COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX).size).toBe(21);
    expect(COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX).toContain(150);
    expect(COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX).toContain(251);
    expect(COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX).toContain(386);
    expect(COMPETITIVE_SPAWN_LOCAL_BIAS_PERCENT).toBe(25);
  });

  it("gets global species from battle-ready forms rather than encounter tables", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("FROM content_release_pointers pointer")) {
        return { rows: [{ content_release_id: "release-1", ruleset_id: "ruleset-1" }] };
      }
      if (sql.includes("JOIN LATERAL")) {
        return {
          rows: [
            {
              form_id: "form-common",
              species_id: "species-common",
              national_dex: 16,
              species_slug: "pidgey",
              display_name: "Pidgey",
              type1_slug: "normal",
              type2_slug: "flying",
              catch_rate: 255,
              min_level: 5,
              max_level: 15,
              area_id: null,
            },
            {
              form_id: "form-rare",
              species_id: "species-rare",
              national_dex: 374,
              species_slug: "beldum",
              display_name: "Beldum",
              type1_slug: "steel",
              type2_slug: "psychic",
              catch_rate: 3,
              min_level: 5,
              max_level: 15,
              area_id: null,
            },
          ],
        };
      }
      throw new Error("Unexpected SQL in competitive pool test");
    });

    const repository = new PostgresCompetitiveSpawnRepository({ query } as unknown as Pool);
    const result = await repository.candidateContext(null);

    expect(result?.globalCandidates.map((candidate) => [candidate.speciesSlug, candidate.weight]))
      .toEqual([["pidgey", 100], ["beldum", 4]]);
    expect(result?.localCandidates).toEqual([]);

    const globalSql = query.mock.calls[1]?.[0] ?? "";
    expect(globalSql).toContain("JOIN LATERAL");
    expect(globalSql).toContain("move_learnset_entries");
    expect(globalSql).toContain("pokemon_form_ability_options");
    expect(globalSql).not.toContain("FROM encounter_tables");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "release-1",
      COMPETITIVE_SPAWN_EXCLUDED_NATIONAL_DEX,
    ]);
  });
});
