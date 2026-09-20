import type { Pool, PoolClient } from "pg";
import { CatalogService } from "../../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../../src/platform/catalog/postgres-catalog-repository.js";
import { gen123Id } from "./ids.js";

export interface Gen123MechanicsOverlayInput {
  readonly parentReleaseId: string;
  readonly sourceReleaseId: string;
  readonly targetReleaseId: string;
  readonly targetReleaseNo: bigint;
  readonly targetReleaseName: string;
}

export interface Gen123MechanicsOverlayReport {
  readonly releaseId: string;
  readonly rulesetId: string;
  readonly parentReleaseId: string;
  readonly sourceReleaseId: string;
  readonly copied: Readonly<Record<string, number>>;
}

function chunks<T>(values: readonly T[], size = 250): readonly T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  conflict: string,
): Promise<void> {
  for (const batch of chunks(rows)) {
    if (batch.length === 0) continue;
    const values: unknown[] = [];
    const tuples = batch.map((row, rowIndex) => {
      if (row.length !== columns.length) {
        throw new Error(`${table}: column/value mismatch`);
      }
      const offset = rowIndex * columns.length;
      for (const value of row) values.push(value);
      return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")} ${conflict}`,
      values,
    );
  }
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

function requirePositiveInt(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`${label} must be a UUID`);
  }
  return value;
}

async function ensureTargetClone(pool: Pool, input: Gen123MechanicsOverlayInput): Promise<void> {
  const existing = await pool.query<{
    status: string;
    parent_release_id: string | null;
    release_no: string;
  }>(
    `SELECT status,parent_release_id,release_no::text
       FROM content_releases
      WHERE id=$1`,
    [input.targetReleaseId],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    if (
      row.status !== "DRAFT" ||
      row.parent_release_id !== input.parentReleaseId ||
      row.release_no !== input.targetReleaseNo.toString()
    ) {
      throw new Error(`Existing mechanics overlay release is incompatible: ${JSON.stringify(row)}`);
    }
    return;
  }

  const catalog = new CatalogService(new PostgresCatalogRepository(pool));
  const cloned = await catalog.clonePublishedRelease({
    parentReleaseId: input.parentReleaseId,
    newReleaseId: input.targetReleaseId,
    releaseNo: input.targetReleaseNo,
    name: input.targetReleaseName,
  });
  if (!cloned.ok) {
    throw new Error(`clone Zhoulia release failed [${cloned.error.code}]: ${cloned.error.message}`);
  }
}

export async function composeGen123MechanicsOverlay(
  pool: Pool,
  input: Gen123MechanicsOverlayInput,
): Promise<Gen123MechanicsOverlayReport> {
  await ensureTargetClone(pool, input);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `catalog-release:${input.targetReleaseId}`,
    ]);

    const target = await client.query<{ status: string }>(
      "SELECT status FROM content_releases WHERE id=$1 FOR UPDATE",
      [input.targetReleaseId],
    );
    if (target.rows[0]?.status !== "DRAFT") {
      throw new Error("Gen I-III mechanics overlay requires a DRAFT target release");
    }

    const source = await client.query<{
      status: string;
      default_ruleset_id: string;
      ruleset_status: string;
    }>(
      `SELECT release.status,
              release.default_ruleset_id,
              ruleset.status AS ruleset_status
         FROM content_releases release
         JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
        WHERE release.id=$1`,
      [input.sourceReleaseId],
    );
    const sourceRow = source.rows[0];
    if (sourceRow === undefined) throw new Error("Gen I-III source release does not exist");
    if (!["DRAFT", "VALIDATED", "PUBLISHED"].includes(sourceRow.status)) {
      throw new Error(`Unexpected Gen I-III source release status ${sourceRow.status}`);
    }
    if (!["VALIDATED", "PUBLISHED"].includes(sourceRow.ruleset_status)) {
      throw new Error(`Gen I-III source ruleset is not ready: ${sourceRow.ruleset_status}`);
    }

    await client.query(
      `UPDATE content_releases
          SET default_ruleset_id=$2,
              name=$3
        WHERE id=$1 AND status='DRAFT'`,
      [input.targetReleaseId, sourceRow.default_ruleset_id, input.targetReleaseName],
    );

    const copied: Record<string, number> = {};

    const types = await client.query<{
      type_id: string;
      display_name: string;
      active: boolean;
      data: unknown;
    }>(
      `SELECT type_id,display_name,active,data
         FROM pokemon_type_revisions
        WHERE content_release_id=$1
        ORDER BY type_id`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "pokemon_type_revisions",
      ["id", "content_release_id", "type_id", "display_name", "active", "data"],
      types.rows.map((row) => [
        gen123Id(`overlay:${input.targetReleaseId}:type:${row.type_id}`),
        input.targetReleaseId,
        row.type_id,
        row.display_name,
        row.active,
        JSON.stringify(row.data),
      ]),
      `ON CONFLICT (content_release_id,type_id)
       DO UPDATE SET display_name=EXCLUDED.display_name,active=EXCLUDED.active,data=EXCLUDED.data`,
    );
    copied.types = types.rows.length;

    const species = await client.query<{
      species_id: string;
      display_name: string;
      catch_rate: number | null;
      base_exp: number | null;
      active: boolean;
      data: unknown;
    }>(
      `SELECT species_id,display_name,catch_rate,base_exp,active,data
         FROM pokemon_species_revisions
        WHERE content_release_id=$1
        ORDER BY species_id`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "pokemon_species_revisions",
      [
        "id",
        "content_release_id",
        "species_id",
        "display_name",
        "catch_rate",
        "base_exp",
        "active",
        "data",
      ],
      species.rows.map((row) => [
        gen123Id(`overlay:${input.targetReleaseId}:species:${row.species_id}`),
        input.targetReleaseId,
        row.species_id,
        row.display_name,
        row.catch_rate,
        row.base_exp,
        row.active,
        JSON.stringify(row.data),
      ]),
      `ON CONFLICT (content_release_id,species_id)
       DO UPDATE SET display_name=EXCLUDED.display_name,catch_rate=EXCLUDED.catch_rate,
                     base_exp=EXCLUDED.base_exp,active=EXCLUDED.active,data=EXCLUDED.data`,
    );
    copied.species = species.rows.length;

    const forms = await client.query<{
      form_id: string;
      display_name: string;
      type1_id: string;
      type2_id: string | null;
      base_hp: number;
      base_attack: number;
      base_defense: number;
      base_sp_attack: number;
      base_sp_defense: number;
      base_speed: number;
      active: boolean;
      data: unknown;
    }>(
      `SELECT form_id,display_name,type1_id,type2_id,base_hp,base_attack,base_defense,
              base_sp_attack,base_sp_defense,base_speed,active,data
         FROM pokemon_form_revisions
        WHERE content_release_id=$1
        ORDER BY form_id`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "pokemon_form_revisions",
      [
        "id",
        "content_release_id",
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
      forms.rows.map((row) => [
        gen123Id(`overlay:${input.targetReleaseId}:form:${row.form_id}`),
        input.targetReleaseId,
        row.form_id,
        row.display_name,
        row.type1_id,
        row.type2_id,
        row.base_hp,
        row.base_attack,
        row.base_defense,
        row.base_sp_attack,
        row.base_sp_defense,
        row.base_speed,
        row.active,
        JSON.stringify(row.data),
      ]),
      `ON CONFLICT (content_release_id,form_id)
       DO UPDATE SET display_name=EXCLUDED.display_name,type1_id=EXCLUDED.type1_id,
                     type2_id=EXCLUDED.type2_id,base_hp=EXCLUDED.base_hp,
                     base_attack=EXCLUDED.base_attack,base_defense=EXCLUDED.base_defense,
                     base_sp_attack=EXCLUDED.base_sp_attack,base_sp_defense=EXCLUDED.base_sp_defense,
                     base_speed=EXCLUDED.base_speed,active=EXCLUDED.active,data=EXCLUDED.data`,
    );
    copied.forms = forms.rows.length;

    const targetMoves = await client.query<{
      move_id: string;
      effect_key: string | null;
      effect_config: unknown;
      flags: unknown;
    }>(
      `SELECT move_id,effect_key,effect_config,flags
         FROM move_revisions
        WHERE content_release_id=$1`,
      [input.targetReleaseId],
    );
    const targetMoveById = new Map(targetMoves.rows.map((row) => [row.move_id, row] as const));
    const moves = await client.query<{
      move_id: string;
      display_name: string;
      type_id: string;
      category: string;
      power: number | null;
      accuracy: number | null;
      priority: number;
      max_pp: number | null;
      flags: unknown;
      active: boolean;
    }>(
      `SELECT move_id,display_name,type_id,category,power,accuracy,priority,max_pp,flags,active
         FROM move_revisions
        WHERE content_release_id=$1
        ORDER BY move_id`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "move_revisions",
      [
        "id",
        "content_release_id",
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
        "flags",
        "active",
      ],
      moves.rows.map((row) => {
        const inherited = targetMoveById.get(row.move_id);
        const keepEffect = inherited?.effect_key !== null && inherited?.effect_key !== undefined;
        return [
          gen123Id(`overlay:${input.targetReleaseId}:move:${row.move_id}`),
          input.targetReleaseId,
          row.move_id,
          row.display_name,
          row.type_id,
          row.category,
          row.power,
          row.accuracy,
          row.priority,
          row.max_pp,
          keepEffect ? inherited.effect_key : null,
          JSON.stringify(keepEffect ? inherited.effect_config : {}),
          JSON.stringify(inherited?.flags ?? row.flags ?? {}),
          row.active,
        ];
      }),
      `ON CONFLICT (content_release_id,move_id)
       DO UPDATE SET display_name=EXCLUDED.display_name,type_id=EXCLUDED.type_id,
                     category=EXCLUDED.category,power=EXCLUDED.power,accuracy=EXCLUDED.accuracy,
                     priority=EXCLUDED.priority,max_pp=EXCLUDED.max_pp,
                     effect_key=EXCLUDED.effect_key,effect_config=EXCLUDED.effect_config,
                     flags=EXCLUDED.flags,active=EXCLUDED.active`,
    );
    copied.moves = moves.rows.length;

    const targetAbilities = await client.query<{
      ability_id: string;
      effect_key: string | null;
      effect_config: unknown;
    }>(
      `SELECT ability_id,effect_key,effect_config
         FROM ability_revisions
        WHERE content_release_id=$1`,
      [input.targetReleaseId],
    );
    const targetAbilityById = new Map(
      targetAbilities.rows.map((row) => [row.ability_id, row] as const),
    );
    const abilities = await client.query<{
      ability_id: string;
      display_name: string;
      active: boolean;
    }>(
      `SELECT ability_id,display_name,active
         FROM ability_revisions
        WHERE content_release_id=$1
        ORDER BY ability_id`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "ability_revisions",
      [
        "id",
        "content_release_id",
        "ability_id",
        "display_name",
        "effect_key",
        "effect_config",
        "active",
      ],
      abilities.rows.map((row) => {
        const inherited = targetAbilityById.get(row.ability_id);
        const keepEffect = inherited?.effect_key !== null && inherited?.effect_key !== undefined;
        return [
          gen123Id(`overlay:${input.targetReleaseId}:ability:${row.ability_id}`),
          input.targetReleaseId,
          row.ability_id,
          row.display_name,
          keepEffect ? inherited.effect_key : null,
          JSON.stringify(keepEffect ? inherited.effect_config : {}),
          row.active,
        ];
      }),
      `ON CONFLICT (content_release_id,ability_id)
       DO UPDATE SET display_name=EXCLUDED.display_name,effect_key=EXCLUDED.effect_key,
                     effect_config=EXCLUDED.effect_config,active=EXCLUDED.active`,
    );
    copied.abilities = abilities.rows.length;

    const targetItems = await client.query<{
      item_id: string;
      effect_key: string | null;
      effect_config: unknown;
    }>(
      `SELECT item_id,effect_key,effect_config
         FROM item_revisions
        WHERE content_release_id=$1`,
      [input.targetReleaseId],
    );
    const targetItemById = new Map(targetItems.rows.map((row) => [row.item_id, row] as const));
    const items = await client.query<{
      item_id: string;
      display_name: string;
      item_kind: string;
      active: boolean;
    }>(
      `SELECT item_id,display_name,item_kind,active
         FROM item_revisions
        WHERE content_release_id=$1
        ORDER BY item_id`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "item_revisions",
      [
        "id",
        "content_release_id",
        "item_id",
        "display_name",
        "item_kind",
        "effect_key",
        "effect_config",
        "active",
      ],
      items.rows.map((row) => {
        const inherited = targetItemById.get(row.item_id);
        const keepEffect = inherited?.effect_key !== null && inherited?.effect_key !== undefined;
        return [
          gen123Id(`overlay:${input.targetReleaseId}:item:${row.item_id}`),
          input.targetReleaseId,
          row.item_id,
          row.display_name,
          row.item_kind,
          keepEffect ? inherited.effect_key : null,
          JSON.stringify(keepEffect ? inherited.effect_config : {}),
          row.active,
        ];
      }),
      `ON CONFLICT (content_release_id,item_id)
       DO UPDATE SET display_name=EXCLUDED.display_name,item_kind=EXCLUDED.item_kind,
                     effect_key=EXCLUDED.effect_key,effect_config=EXCLUDED.effect_config,
                     active=EXCLUDED.active`,
    );
    copied.items = items.rows.length;

    const natures = await client.query<{
      nature_id: string;
      display_name: string;
      increased_stat: string | null;
      decreased_stat: string | null;
      active: boolean;
    }>(
      `SELECT nature_id,display_name,increased_stat,decreased_stat,active
         FROM nature_revisions
        WHERE content_release_id=$1
        ORDER BY nature_id`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "nature_revisions",
      [
        "id",
        "content_release_id",
        "nature_id",
        "display_name",
        "increased_stat",
        "decreased_stat",
        "active",
      ],
      natures.rows.map((row) => [
        gen123Id(`overlay:${input.targetReleaseId}:nature:${row.nature_id}`),
        input.targetReleaseId,
        row.nature_id,
        row.display_name,
        row.increased_stat,
        row.decreased_stat,
        row.active,
      ]),
      `ON CONFLICT (content_release_id,nature_id)
       DO UPDATE SET display_name=EXCLUDED.display_name,increased_stat=EXCLUDED.increased_stat,
                     decreased_stat=EXCLUDED.decreased_stat,active=EXCLUDED.active`,
    );
    copied.natures = natures.rows.length;

    const formIds = forms.rows.map((row) => row.form_id);
    await client.query(
      `UPDATE pokemon_form_ability_options
          SET active=FALSE
        WHERE content_release_id=$1
          AND form_id=ANY($2::uuid[])
          AND active=TRUE`,
      [input.targetReleaseId, formIds],
    );
    const formAbilities = await client.query<{
      form_id: string;
      ability_id: string;
      slot_kind: string;
      active: boolean;
    }>(
      `SELECT form_id,ability_id,slot_kind,active
         FROM pokemon_form_ability_options
        WHERE content_release_id=$1
        ORDER BY form_id,slot_kind,ability_id`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "pokemon_form_ability_options",
      ["id", "content_release_id", "form_id", "ability_id", "slot_kind", "active"],
      formAbilities.rows.map((row) => [
        gen123Id(
          `overlay:${input.targetReleaseId}:form-ability:${row.form_id}:${row.ability_id}:${row.slot_kind}`,
        ),
        input.targetReleaseId,
        row.form_id,
        row.ability_id,
        row.slot_kind,
        row.active,
      ]),
      `ON CONFLICT (content_release_id,form_id,ability_id,slot_kind)
       DO UPDATE SET active=EXCLUDED.active`,
    );
    copied.formAbilities = formAbilities.rows.length;

    await client.query(
      `UPDATE move_learnset_entries
          SET active=FALSE
        WHERE content_release_id=$1
          AND form_id=ANY($2::uuid[])
          AND active=TRUE`,
      [input.targetReleaseId, formIds],
    );
    const learnsets = await client.query<{
      form_id: string;
      move_id: string;
      learn_method: string;
      learn_level: number | null;
      source_key: string | null;
      active: boolean;
    }>(
      `SELECT form_id,move_id,learn_method,learn_level,source_key,active
         FROM move_learnset_entries
        WHERE content_release_id=$1
        ORDER BY form_id,move_id,learn_method,learn_level NULLS FIRST`,
      [input.sourceReleaseId],
    );
    await insertRows(
      client,
      "move_learnset_entries",
      [
        "id",
        "content_release_id",
        "form_id",
        "move_id",
        "learn_method",
        "learn_level",
        "source_key",
        "active",
      ],
      learnsets.rows.map((row) => [
        gen123Id(
          `overlay:${input.targetReleaseId}:learnset:${row.form_id}:${row.move_id}:${row.learn_method}:${row.learn_level ?? "x"}`,
        ),
        input.targetReleaseId,
        row.form_id,
        row.move_id,
        row.learn_method,
        row.learn_level,
        row.source_key,
        row.active,
      ]),
      `ON CONFLICT (content_release_id,form_id,move_id,learn_method,learn_level)
       DO UPDATE SET source_key=EXCLUDED.source_key,active=EXCLUDED.active`,
    );
    copied.learnsets = learnsets.rows.length;

    await client.query(
      `UPDATE evolution_rules
          SET active=FALSE
        WHERE content_release_id=$1
          AND (from_form_id=ANY($2::uuid[]) OR to_form_id=ANY($2::uuid[]))
          AND active=TRUE`,
      [input.targetReleaseId, formIds],
    );
    const evolutions = await client.query<{
      from_form_id: string;
      to_form_id: string;
      trigger_kind: "LEVEL" | "ITEM" | "CONDITION";
      trigger_config: unknown;
      active: boolean;
    }>(
      `SELECT from_form_id,to_form_id,trigger_kind,trigger_config,active
         FROM evolution_rules
        WHERE content_release_id=$1
        ORDER BY from_form_id,to_form_id,trigger_kind`,
      [input.sourceReleaseId],
    );
    const normalizedEvolutions = evolutions.rows.map((row) => {
      const sourceConfig = asObject(row.trigger_config);
      if (row.trigger_kind === "LEVEL") {
        return {
          ...row,
          triggerConfig: {
            level: requirePositiveInt(
              sourceConfig.minimumLevel,
              `LEVEL evolution ${row.from_form_id}->${row.to_form_id}`,
            ),
          },
        };
      }
      if (row.trigger_kind === "ITEM") {
        return {
          ...row,
          triggerConfig: {
            itemId: requireUuid(
              sourceConfig.sourceItemIdentityId,
              `ITEM evolution ${row.from_form_id}->${row.to_form_id}`,
            ),
          },
        };
      }
      return {
        ...row,
        active: false,
        triggerConfig: { conditionKey: "gen123-unsupported" },
      };
    });
    await insertRows(
      client,
      "evolution_rules",
      [
        "id",
        "content_release_id",
        "from_form_id",
        "to_form_id",
        "trigger_kind",
        "trigger_config",
        "active",
      ],
      normalizedEvolutions.map((row) => [
        gen123Id(
          `overlay:${input.targetReleaseId}:evolution:${row.from_form_id}:${row.to_form_id}:${row.trigger_kind}`,
        ),
        input.targetReleaseId,
        row.from_form_id,
        row.to_form_id,
        row.trigger_kind,
        JSON.stringify(row.triggerConfig),
        row.active,
      ]),
      `ON CONFLICT (content_release_id,from_form_id,to_form_id,trigger_kind)
       DO UPDATE SET trigger_config=EXCLUDED.trigger_config,active=EXCLUDED.active`,
    );
    copied.evolutions = normalizedEvolutions.length;

    await client.query("COMMIT");
    return {
      releaseId: input.targetReleaseId,
      rulesetId: sourceRow.default_ruleset_id,
      parentReleaseId: input.parentReleaseId,
      sourceReleaseId: input.sourceReleaseId,
      copied,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
