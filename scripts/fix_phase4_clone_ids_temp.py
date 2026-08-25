from pathlib import Path
import re

path = Path("src/platform/catalog/postgres-catalog-repository.ts")
text = path.read_text()

if 'import { randomUUID } from "node:crypto";' not in text:
    text = 'import { randomUUID } from "node:crypto";\n' + text

pattern = re.compile(
    r"    const copyStatements = \[.*?\n    await this\.client\.query\(\n      `INSERT INTO encounter_entries\(.*?\n      \[input\.parentReleaseId, input\.newReleaseId\],\n    \);",
    re.S,
)

replacement = '''    const cloneTables = [
      {
        table: "pokemon_type_revisions",
        columns: ["type_id", "display_name", "active", "data"],
      },
      {
        table: "pokemon_species_revisions",
        columns: ["species_id", "display_name", "catch_rate", "base_exp", "active", "data"],
      },
      {
        table: "pokemon_form_revisions",
        columns: [
          "form_id",
          "display_name",
          "type1_id",
          "type2_id",
          "base_hp",
          "base_attack",
          "base_defense",
          "base_sp_attack",
          "base_sp_defense",
          "base_speed",
          "active",
          "data",
        ],
      },
      {
        table: "move_revisions",
        columns: [
          "move_id",
          "display_name",
          "type_id",
          "category",
          "power",
          "accuracy",
          "priority",
          "max_pp",
          "effect_key",
          "effect_config",
          "active",
        ],
      },
      {
        table: "ability_revisions",
        columns: ["ability_id", "display_name", "effect_key", "effect_config", "active"],
      },
      {
        table: "item_revisions",
        columns: ["item_id", "display_name", "item_kind", "effect_key", "effect_config", "active"],
      },
      {
        table: "nature_revisions",
        columns: ["nature_id", "display_name", "increased_stat", "decreased_stat", "active"],
      },
      {
        table: "effect_revisions",
        columns: ["effect_id", "scope", "stacking_policy", "duration_model", "rules", "active"],
      },
      {
        table: "region_revisions",
        columns: ["region_id", "display_name", "active", "data"],
      },
      {
        table: "area_revisions",
        columns: ["area_id", "display_name", "active", "data"],
      },
      {
        table: "area_connection_revisions",
        columns: ["connection_id", "access_rule", "active"],
      },
      {
        table: "encounter_table_revisions",
        columns: ["encounter_table_id", "active", "conditions"],
      },
      {
        table: "pokemon_form_ability_options",
        columns: ["form_id", "ability_id", "slot_kind", "active"],
      },
      {
        table: "move_learnset_entries",
        columns: ["form_id", "move_id", "learn_method", "learn_level", "source_key", "active"],
      },
      {
        table: "evolution_rules",
        columns: ["from_form_id", "to_form_id", "trigger_kind", "trigger_config", "active"],
      },
    ] as const;

    for (const spec of cloneTables) {
      const source = await this.client.query<Record<string, unknown>>(
        `SELECT ${spec.columns.join(", ")} FROM ${spec.table}
         WHERE content_release_id = $1 ORDER BY id`,
        [input.parentReleaseId],
      );
      for (const row of source.rows) {
        const values = spec.columns.map((column) => row[column]);
        const placeholders = values.map((_, index) => `$${index + 3}`).join(", ");
        await this.client.query(
          `INSERT INTO ${spec.table}(id, content_release_id, ${spec.columns.join(", ")})
           VALUES ($1, $2, ${placeholders})`,
          [randomUUID(), input.newReleaseId, ...values],
        );
      }
    }

    const newEncounterRevisions = await this.client.query<{
      id: string;
      encounter_table_id: string;
    }>(
      `SELECT id, encounter_table_id FROM encounter_table_revisions
       WHERE content_release_id = $1`,
      [input.newReleaseId],
    );
    const newRevisionByTable = new Map(
      newEncounterRevisions.rows.map((row) => [row.encounter_table_id, row.id]),
    );
    const sourceEntries = await this.client.query<{
      encounter_table_id: string;
      form_id: string;
      weight: string;
      min_level: number;
      max_level: number;
      active: boolean;
      conditions: unknown;
    }>(
      `SELECT old_revision.encounter_table_id, entry.form_id, entry.weight::text,
              entry.min_level, entry.max_level, entry.active, entry.conditions
       FROM encounter_entries entry
       JOIN encounter_table_revisions old_revision
         ON old_revision.id = entry.encounter_table_revision_id
       WHERE old_revision.content_release_id = $1
       ORDER BY entry.id`,
      [input.parentReleaseId],
    );
    for (const entry of sourceEntries.rows) {
      const newRevisionId = newRevisionByTable.get(entry.encounter_table_id);
      if (newRevisionId === undefined) {
        throw new Error("Cloned encounter table revision mapping is incomplete");
      }
      await this.client.query(
        `INSERT INTO encounter_entries(
           id, encounter_table_revision_id, form_id, weight, min_level, max_level, active, conditions
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          randomUUID(),
          newRevisionId,
          entry.form_id,
          entry.weight,
          entry.min_level,
          entry.max_level,
          entry.active,
          JSON.stringify(entry.conditions),
        ],
      );
    }'''

text, count = pattern.subn(replacement, text)
if count != 1:
    raise SystemExit(f"Expected clone SQL block exactly once, replaced {count}")
if "gen_random_uuid()" in text:
    raise SystemExit("Database-generated UUID remained in catalog repository")
path.write_text(text)
