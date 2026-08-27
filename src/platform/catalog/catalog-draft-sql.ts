import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ContentLifecycleStatusSchema } from "../../modules/catalog/contracts.js";
import type {
  CatalogDraftCreateInput,
  CatalogDraftDeactivateInput,
  CatalogDraftEncounterEntry,
  CatalogDraftInspectInput,
  CatalogDraftReplaceInput,
  CatalogDraftResourceKind,
  CatalogDraftResourceView,
} from "../../modules/catalog/draft-contracts.js";
import { parseEncounterConditions } from "../../modules/catalog/encounter-contracts.js";

export interface CatalogReleaseAdminRow {
  readonly status: string;
  readonly revision: string;
}

export function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected persisted catalog JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

export async function loadCatalogReleaseAdminRow(
  client: PoolClient,
  releaseId: string,
  lock = false,
): Promise<CatalogReleaseAdminRow | null> {
  const result = await client.query<CatalogReleaseAdminRow>(
    `SELECT status, revision::text
     FROM content_releases
     WHERE id = $1
     ${lock ? "FOR UPDATE" : ""}`,
    [releaseId],
  );
  return result.rows[0] ?? null;
}

function viewBase(
  input: CatalogDraftInspectInput,
  release: CatalogReleaseAdminRow,
): Omit<CatalogDraftResourceView, "active" | "data"> {
  return {
    releaseId: input.releaseId,
    releaseRevision: release.revision,
    releaseStatus: ContentLifecycleStatusSchema.parse(release.status),
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
  };
}

export async function inspectCatalogDraftResource(
  client: PoolClient,
  input: CatalogDraftInspectInput,
): Promise<CatalogDraftResourceView | null> {
  const release = await loadCatalogReleaseAdminRow(client, input.releaseId);
  if (release === null) return null;
  const base = viewBase(input, release);

  if (input.resourceKind === "SPECIES") {
    const result = await client.query<{
      slug: string;
      national_dex: number;
      display_name: string;
      catch_rate: number | null;
      base_exp: number | null;
      active: boolean;
      data: unknown;
    }>(
      `SELECT identity.slug, identity.national_dex, revision.display_name,
              revision.catch_rate, revision.base_exp, revision.active, revision.data
       FROM pokemon_species identity
       JOIN pokemon_species_revisions revision
         ON revision.species_id = identity.id AND revision.content_release_id = $1
       WHERE identity.id = $2`,
      [input.releaseId, input.resourceId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          ...base,
          active: row.active,
          data: {
            slug: row.slug,
            nationalDex: row.national_dex,
            displayName: row.display_name,
            catchRate: row.catch_rate,
            baseExp: row.base_exp,
            data: jsonRecord(row.data),
          },
        };
  }

  if (input.resourceKind === "MOVE") {
    const result = await client.query<{
      slug: string;
      display_name: string;
      type_id: string;
      category: "PHYSICAL" | "SPECIAL" | "STATUS";
      power: number | null;
      accuracy: number | null;
      priority: number;
      max_pp: number | null;
      effect_key: string | null;
      effect_config: unknown;
      flags: unknown;
      active: boolean;
    }>(
      `SELECT identity.slug, revision.display_name, revision.type_id, revision.category,
              revision.power, revision.accuracy, revision.priority, revision.max_pp,
              revision.effect_key, revision.effect_config, revision.flags, revision.active
       FROM moves identity
       JOIN move_revisions revision
         ON revision.move_id = identity.id AND revision.content_release_id = $1
       WHERE identity.id = $2`,
      [input.releaseId, input.resourceId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          ...base,
          active: row.active,
          data: {
            slug: row.slug,
            displayName: row.display_name,
            typeId: row.type_id,
            category: row.category,
            power: row.power,
            accuracy: row.accuracy,
            priority: row.priority,
            maxPp: row.max_pp,
            effectKey: row.effect_key,
            effectConfig: jsonRecord(row.effect_config),
            flags: jsonRecord(row.flags),
          },
        };
  }

  if (input.resourceKind === "ITEM") {
    const result = await client.query<{
      slug: string;
      display_name: string;
      item_kind: string;
      effect_key: string | null;
      effect_config: unknown;
      active: boolean;
    }>(
      `SELECT identity.slug, revision.display_name, revision.item_kind,
              revision.effect_key, revision.effect_config, revision.active
       FROM items identity
       JOIN item_revisions revision
         ON revision.item_id = identity.id AND revision.content_release_id = $1
       WHERE identity.id = $2`,
      [input.releaseId, input.resourceId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          ...base,
          active: row.active,
          data: {
            slug: row.slug,
            displayName: row.display_name,
            itemKind: row.item_kind,
            effectKey: row.effect_key,
            effectConfig: jsonRecord(row.effect_config),
          },
        };
  }

  if (input.resourceKind === "AREA") {
    const result = await client.query<{
      slug: string;
      region_id: string;
      display_name: string;
      active: boolean;
      data: unknown;
    }>(
      `SELECT identity.slug, identity.region_id, revision.display_name, revision.active, revision.data
       FROM areas identity
       JOIN area_revisions revision
         ON revision.area_id = identity.id AND revision.content_release_id = $1
       WHERE identity.id = $2`,
      [input.releaseId, input.resourceId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          ...base,
          active: row.active,
          data: {
            slug: row.slug,
            regionId: row.region_id,
            displayName: row.display_name,
            data: jsonRecord(row.data),
          },
        };
  }

  if (input.resourceKind === "ENCOUNTER_TABLE") {
    const result = await client.query<{
      revision_id: string;
      slug: string;
      area_id: string;
      active: boolean;
      conditions: unknown;
    }>(
      `SELECT revision.id AS revision_id, identity.slug, identity.area_id,
              revision.active, revision.conditions
       FROM encounter_tables identity
       JOIN encounter_table_revisions revision
         ON revision.encounter_table_id = identity.id AND revision.content_release_id = $1
       WHERE identity.id = $2`,
      [input.releaseId, input.resourceId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const entries = await client.query<{
      id: string;
      form_id: string;
      weight: string;
      min_level: number;
      max_level: number;
      active: boolean;
      conditions: unknown;
    }>(
      `SELECT id, form_id, weight::text, min_level, max_level, active, conditions
       FROM encounter_entries
       WHERE encounter_table_revision_id = $1
       ORDER BY id`,
      [row.revision_id],
    );
    const tableConditions = parseEncounterConditions(row.conditions);
    if (!tableConditions.success) throw new Error("Persisted encounter table conditions are invalid");
    return {
      ...base,
      active: row.active,
      data: {
        slug: row.slug,
        areaId: row.area_id,
        conditions: tableConditions.data,
        entries: entries.rows.map((entry) => {
          const conditions = parseEncounterConditions(entry.conditions);
          if (!conditions.success) throw new Error("Persisted encounter entry conditions are invalid");
          return {
            entryId: entry.id,
            formId: entry.form_id,
            weight: entry.weight,
            minLevel: entry.min_level,
            maxLevel: entry.max_level,
            active: entry.active,
            conditions: conditions.data,
          };
        }),
      },
    };
  }

  if (input.resourceKind === "REWARD") {
    const result = await client.query<{
      slug: string;
      display_name: string;
      program: unknown;
      active: boolean;
    }>(
      `SELECT identity.slug, revision.display_name, revision.program, revision.active
       FROM reward_definitions identity
       JOIN reward_revisions revision
         ON revision.reward_id = identity.id AND revision.content_release_id = $1
       WHERE identity.id = $2`,
      [input.releaseId, input.resourceId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          ...base,
          active: row.active,
          data: { slug: row.slug, displayName: row.display_name, program: jsonRecord(row.program) },
        };
  }

  const result = await client.query<{
    slug: string;
    scope: "PLAYER" | "POKEMON" | "BATTLE_PARTICIPANT" | "AREA";
    stacking_policy: string;
    duration_model: string;
    rules: unknown;
    active: boolean;
  }>(
    `SELECT identity.slug, revision.scope, revision.stacking_policy,
            revision.duration_model, revision.rules, revision.active
     FROM effects identity
     JOIN effect_revisions revision
       ON revision.effect_id = identity.id AND revision.content_release_id = $1
     WHERE identity.id = $2`,
    [input.releaseId, input.resourceId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        ...base,
        active: row.active,
        data: {
          slug: row.slug,
          scope: row.scope,
          stackingPolicy: row.stacking_policy,
          durationModel: row.duration_model,
          rules: jsonRecord(row.rules),
        },
      };
}

async function insertEncounterEntries(
  client: PoolClient,
  revisionId: string,
  entries: readonly CatalogDraftEncounterEntry[],
): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO encounter_entries(
         id, encounter_table_revision_id, form_id, weight, min_level, max_level, active, conditions
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        randomUUID(),
        revisionId,
        entry.formId,
        entry.weight,
        entry.minLevel,
        entry.maxLevel,
        entry.active,
        JSON.stringify(entry.conditions),
      ],
    );
  }
}

async function assertRewardReferences(
  client: PoolClient,
  releaseId: string,
  program: { readonly grants: readonly Record<string, unknown>[] },
): Promise<void> {
  for (const grant of program.grants) {
    if (grant.kind === "ITEM") {
      const itemId = String(grant.itemId);
      const item = await client.query(
        `SELECT 1 FROM item_revisions
         WHERE content_release_id = $1 AND item_id = $2 AND active = TRUE`,
        [releaseId, itemId],
      );
      if (item.rowCount !== 1) throw new CatalogReferenceError("Reward ITEM must reference an active item in the same release");
    }
    if (grant.kind === "CURRENCY") {
      const currencyId = String(grant.currencyId);
      const currency = await client.query(`SELECT 1 FROM currency_definitions WHERE id = $1`, [currencyId]);
      if (currency.rowCount !== 1) throw new CatalogReferenceError("Reward CURRENCY must reference an existing currency");
    }
  }
}

export async function createCatalogDraftResource(
  client: PoolClient,
  input: CatalogDraftCreateInput,
  resourceId: string,
): Promise<void> {
  const revisionId = randomUUID();
  const resource = input.resource;
  if (resource.kind === "SPECIES") {
    await client.query(`INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, $2, $3)`, [
      resourceId,
      resource.nationalDex,
      resource.slug,
    ]);
    await client.query(
      `INSERT INTO pokemon_species_revisions(
         id, content_release_id, species_id, display_name, catch_rate, base_exp, active, data
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7::jsonb)`,
      [revisionId, input.releaseId, resourceId, resource.displayName, resource.catchRate, resource.baseExp, JSON.stringify(resource.data)],
    );
    return;
  }
  if (resource.kind === "MOVE") {
    await client.query(`INSERT INTO moves(id, slug) VALUES ($1, $2)`, [resourceId, resource.slug]);
    await client.query(
      `INSERT INTO move_revisions(
         id, content_release_id, move_id, display_name, type_id, category, power, accuracy,
         priority, max_pp, effect_key, effect_config, flags, active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, TRUE)`,
      [revisionId, input.releaseId, resourceId, resource.displayName, resource.typeId, resource.category, resource.power, resource.accuracy, resource.priority, resource.maxPp, resource.effectKey, JSON.stringify(resource.effectConfig), JSON.stringify(resource.flags)],
    );
    return;
  }
  if (resource.kind === "ITEM") {
    await client.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [resourceId, resource.slug]);
    await client.query(
      `INSERT INTO item_revisions(
         id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config, active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, TRUE)`,
      [revisionId, input.releaseId, resourceId, resource.displayName, resource.itemKind, resource.effectKey, JSON.stringify(resource.effectConfig)],
    );
    return;
  }
  if (resource.kind === "AREA") {
    await client.query(`INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)`, [resourceId, resource.regionId, resource.slug]);
    await client.query(
      `INSERT INTO area_revisions(id, content_release_id, area_id, display_name, active, data)
       VALUES ($1, $2, $3, $4, TRUE, $5::jsonb)`,
      [revisionId, input.releaseId, resourceId, resource.displayName, JSON.stringify(resource.data)],
    );
    return;
  }
  if (resource.kind === "ENCOUNTER_TABLE") {
    await client.query(`INSERT INTO encounter_tables(id, area_id, slug) VALUES ($1, $2, $3)`, [resourceId, resource.areaId, resource.slug]);
    await client.query(
      `INSERT INTO encounter_table_revisions(
         id, content_release_id, encounter_table_id, active, conditions
       ) VALUES ($1, $2, $3, TRUE, $4::jsonb)`,
      [revisionId, input.releaseId, resourceId, JSON.stringify(resource.conditions)],
    );
    await insertEncounterEntries(client, revisionId, resource.entries);
    return;
  }
  if (resource.kind === "REWARD") {
    await assertRewardReferences(client, input.releaseId, resource.program);
    await client.query(`INSERT INTO reward_definitions(id, slug) VALUES ($1, $2)`, [resourceId, resource.slug]);
    await client.query(
      `INSERT INTO reward_revisions(
         id, content_release_id, reward_id, display_name, program, active
       ) VALUES ($1, $2, $3, $4, $5::jsonb, TRUE)`,
      [revisionId, input.releaseId, resourceId, resource.displayName, JSON.stringify(resource.program)],
    );
    return;
  }
  await client.query(`INSERT INTO effects(id, slug) VALUES ($1, $2)`, [resourceId, resource.slug]);
  await client.query(
    `INSERT INTO effect_revisions(
       id, content_release_id, effect_id, scope, stacking_policy, duration_model, rules, active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, TRUE)`,
    [revisionId, input.releaseId, resourceId, resource.scope, resource.stackingPolicy, resource.durationModel, JSON.stringify(resource.rules)],
  );
}

export async function replaceCatalogDraftResource(
  client: PoolClient,
  input: CatalogDraftReplaceInput,
): Promise<boolean> {
  const resource = input.resource;
  if (resource.kind === "SPECIES") {
    const result = await client.query(
      `UPDATE pokemon_species_revisions
       SET display_name = $3, catch_rate = $4, base_exp = $5, data = $6::jsonb, active = TRUE
       WHERE content_release_id = $1 AND species_id = $2`,
      [input.releaseId, input.resourceId, resource.displayName, resource.catchRate, resource.baseExp, JSON.stringify(resource.data)],
    );
    return result.rowCount === 1;
  }
  if (resource.kind === "MOVE") {
    const result = await client.query(
      `UPDATE move_revisions
       SET display_name = $3, type_id = $4, category = $5, power = $6, accuracy = $7,
           priority = $8, max_pp = $9, effect_key = $10, effect_config = $11::jsonb,
           flags = $12::jsonb, active = TRUE
       WHERE content_release_id = $1 AND move_id = $2`,
      [input.releaseId, input.resourceId, resource.displayName, resource.typeId, resource.category, resource.power, resource.accuracy, resource.priority, resource.maxPp, resource.effectKey, JSON.stringify(resource.effectConfig), JSON.stringify(resource.flags)],
    );
    return result.rowCount === 1;
  }
  if (resource.kind === "ITEM") {
    const result = await client.query(
      `UPDATE item_revisions
       SET display_name = $3, item_kind = $4, effect_key = $5, effect_config = $6::jsonb, active = TRUE
       WHERE content_release_id = $1 AND item_id = $2`,
      [input.releaseId, input.resourceId, resource.displayName, resource.itemKind, resource.effectKey, JSON.stringify(resource.effectConfig)],
    );
    return result.rowCount === 1;
  }
  if (resource.kind === "AREA") {
    const result = await client.query(
      `UPDATE area_revisions
       SET display_name = $3, data = $4::jsonb, active = TRUE
       WHERE content_release_id = $1 AND area_id = $2`,
      [input.releaseId, input.resourceId, resource.displayName, JSON.stringify(resource.data)],
    );
    return result.rowCount === 1;
  }
  if (resource.kind === "ENCOUNTER_TABLE") {
    const revision = await client.query<{ id: string }>(
      `UPDATE encounter_table_revisions
       SET conditions = $3::jsonb, active = TRUE
       WHERE content_release_id = $1 AND encounter_table_id = $2
       RETURNING id`,
      [input.releaseId, input.resourceId, JSON.stringify(resource.conditions)],
    );
    const revisionId = revision.rows[0]?.id;
    if (revisionId === undefined) return false;
    await client.query(`DELETE FROM encounter_entries WHERE encounter_table_revision_id = $1`, [revisionId]);
    await insertEncounterEntries(client, revisionId, resource.entries);
    return true;
  }
  if (resource.kind === "REWARD") {
    await assertRewardReferences(client, input.releaseId, resource.program);
    const result = await client.query(
      `UPDATE reward_revisions
       SET display_name = $3, program = $4::jsonb, active = TRUE
       WHERE content_release_id = $1 AND reward_id = $2`,
      [input.releaseId, input.resourceId, resource.displayName, JSON.stringify(resource.program)],
    );
    return result.rowCount === 1;
  }
  const result = await client.query(
    `UPDATE effect_revisions
     SET scope = $3, stacking_policy = $4, duration_model = $5, rules = $6::jsonb, active = TRUE
     WHERE content_release_id = $1 AND effect_id = $2`,
    [input.releaseId, input.resourceId, resource.scope, resource.stackingPolicy, resource.durationModel, JSON.stringify(resource.rules)],
  );
  return result.rowCount === 1;
}

const revisionTarget: Readonly<
  Record<CatalogDraftResourceKind, { readonly table: string; readonly idColumn: string }>
> = {
  SPECIES: { table: "pokemon_species_revisions", idColumn: "species_id" },
  MOVE: { table: "move_revisions", idColumn: "move_id" },
  ITEM: { table: "item_revisions", idColumn: "item_id" },
  AREA: { table: "area_revisions", idColumn: "area_id" },
  ENCOUNTER_TABLE: { table: "encounter_table_revisions", idColumn: "encounter_table_id" },
  REWARD: { table: "reward_revisions", idColumn: "reward_id" },
  EFFECT: { table: "effect_revisions", idColumn: "effect_id" },
};

export async function deactivateCatalogDraftResource(
  client: PoolClient,
  input: CatalogDraftDeactivateInput,
): Promise<boolean> {
  const target = revisionTarget[input.resourceKind];
  const result = await client.query(
    `UPDATE ${target.table}
     SET active = FALSE
     WHERE content_release_id = $1 AND ${target.idColumn} = $2`,
    [input.releaseId, input.resourceId],
  );
  return result.rowCount === 1;
}

export class CatalogReferenceError extends Error {}
