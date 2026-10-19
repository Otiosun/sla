import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function migration(file: string): string {
  // Remove standalone SQL comments so audit assertions target executable statements.
  return readFileSync(new URL(`../../db/migrations/${file}.sql`, import.meta.url), "utf8").replace(
    /^\s*--[^\n]*$/gm,
    "",
  );
}

const schemaOnlyPrerequisites = [
  "0063_admin_pokemon_xp_adjustments",
  "0064_competitive_spawns",
  "0065_competitive_spawn_activity",
  "0066_competitive_spawn_group_settings",
  "0067_competitive_spawn_rewards",
  "0068_competitive_spawn_guess_guard",
  "0069_competitive_spawn_publication",
  "0070_competitive_spawn_activity_target_fairness",
  "0071_competitive_spawn_canary_controls",
] as const;

describe("Premium migration side-effect boundary", () => {
  it.each(schemaOnlyPrerequisites)(
    "%s remains schema-only rather than changing player/admin records",
    (name) => {
      const sql = migration(name);
      expect(sql).not.toMatch(/^\s*(?:DROP|TRUNCATE|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/im);
      expect(sql).not.toMatch(/\bALTER\s+TABLE\b[^;]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i);
      expect(sql).toMatch(/\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b/i);
    },
  );

  it("keeps competitive spawns opt-in and disabled for missing/new group settings", () => {
    const sql = migration("0066_competitive_spawn_group_settings");
    expect(sql).toMatch(/enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i);
    expect(sql).not.toMatch(/\bDEFAULT\s+TRUE\b/i);
  });

  it("makes the non-Premium admin role mutation in 0072 explicit and tightly scoped", () => {
    const sql = migration("0072_owner_player_identity_change_capability");
    const mutations = [...sql.matchAll(/\b(INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_]+)/gi)].map(
      (match) => match[2]?.toLowerCase(),
    );
    expect(mutations).toEqual([
      "capabilities",
      "admin_role_capabilities",
      "admin_role_capabilities",
    ]);
    expect(sql).toContain("'player.identity.change'");
    expect(sql).toContain("role.slug = 'OWNER_SECURITY_ADMIN'");
    expect(sql).toContain("role.slug <> 'OWNER_SECURITY_ADMIN'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|UPDATE)\s+(?:TABLE\s+)?\b/i);
  });

  it("keeps the only currently defined purchasable product at 2XP × seven days", () => {
    const sql = migration("0075_xp2x_entitlement_product");
    expect(sql).toMatch(/'2XP'[\s\S]*?'BRL'[\s\S]*?4000[\s\S]*?52/);
    expect(sql).toContain('"durationSecondsPerUnit":604800');
    expect(sql).toContain('"multiplier":2');
    expect(sql).toContain("CREATE FUNCTION pokemon_battle_xp_multiplier_for");
    expect(sql).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE\s+TABLE)\s+(?:players|pokemon_instances|trainer_progression)\b/i);
  });
});
