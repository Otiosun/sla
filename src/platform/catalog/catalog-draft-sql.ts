import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  CatalogDraftCreateInput,
  CatalogDraftDeactivateInput,
  CatalogDraftEncounterEntry,
  CatalogDraftReplaceInput,
  CatalogDraftResourceKind,
} from "../../modules/catalog/draft-contracts.js";

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
  program: {
    readonly grants: readonly (
      | { readonly kind: "ITEM"; readonly itemId: string }
      | { readonly kind: "CURRENCY"; readonly currencyId: string }
      | { readonly kind: "TRAINER_POINTS" }
    )[];
  },
): Promise<void> {
  for (const grant of program.grants) {
    if (grant.kind === "ITEM") {
      const item = await client.query(
        `SELECT 1 FROM item_revisions
         WHERE content_release_id = $1 AND item_id = $2 AND active = TRUE`,
        [releaseId, grant.itemId],
      );
      if (item.rowCount !== 1) {
        throw new CatalogReferenceError(
          "Reward ITEM must reference an active item in the same release",
        );
      }
    }
    if (grant.kind === "CURRENCY") {
      const currency = await client.query(
        `SELECT 1 FROM currency_definitions WHERE id = $1`,
        [grant.currencyId],
      );
      if (currency.rowCount !== 1) {
        throw new CatalogReferenceError("Reward CURRENCY must reference an existing currency");
      }
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
    await client.query(
      `INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, $2, $3)`,
      [resourceId, resource.nationalDex, resource.slug],
    );
    await client.query(
      `INSERT INTO pokemon_species_revisions(
         id, content_release_id, species_id, display_name, catch_rate, base_exp, active, data
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7::jsonb)`,
      [
        revisionId,
        input.releaseId,
        resourceId,
        resource.displayName,
        resource.catchRate,
        resource.baseExp,
        JSON.stringify(resource.data),
      ],
    );
    return;
  }
  if (resource.kind === "MOVE") {
    await client.query(`INSERT INTO moves(id, slug) VALUES ($1, $2)`, [
      resourceId,
      resource.slug,
    ]);
    await client.query(
      `INSERT INTO move_revisions(
         id, content_release_id, move_id, display_name, type_id, category, power, accuracy,
         priority, max_pp, effect_key, effect_config, flags, active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, TRUE)`,
      [
        revisionId,
        input.releaseId,
        resourceId,
        resource.displayName,
        resource.typeId,
        resource.category,
        resource.power,
        resource.accuracy,
        resource.priority,
        resource.maxPp,
        resource.effectKey,
        JSON.stringify(resource.effectConfig),
        JSON.stringify(resource.flags),
      ],
    );
    return;
  }
  if (resource.kind === "ITEM") {
    await client.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [
      resourceId,
      resource.slug,
    ]);
    await client.query(
      `INSERT INTO item_revisions(
         id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config, active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, TRUE)`,
      [
        revisionId,
        input.releaseId,
        resourceId,
        resource.displayName,
        resource.itemKind,
        resource.effectKey,
        JSON.stringify(resource.effectConfig),
      ],
    );
    return;
  }
  if (resource.kind === "AREA") {
    await client.query(`INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)`, [
      resourceId,
      resource.regionId,
      resource.slug,
    ]);
    await client.query(
      `INSERT INTO area_revisions(id, content_release_id, area_id, display_name, active, data)
       VALUES ($1, $2, $3, $4, TRUE, $5::jsonb)`,
      [
        revisionId,
        input.releaseId,
        resourceId,
        resource.displayName,
        JSON.stringify(resource.data),
      ],
    );
    return;
  }
  if (resource.kind === "ENCOUNTER_TABLE") {
    await client.query(
      `INSERT INTO encounter_tables(id, area_id, slug) VALUES ($1, $2, $3)`,
      [resourceId, resource.areaId, resource.slug],
    );
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
    await client.query(`INSERT INTO reward_definitions(id, slug) VALUES ($1, $2)`, [
      resourceId,
      resource.slug,
    ]);
    await client.query(
      `INSERT INTO reward_revisions(
         id, content_release_id, reward_id, display_name, program, active
       ) VALUES ($1, $2, $3, $4, $5::jsonb, TRUE)`,
      [
        revisionId,
        input.releaseId,
        resourceId,
        resource.displayName,
        JSON.stringify(resource.program),
      ],
    );
    return;
  }
  await client.query(`INSERT INTO effects(id, slug) VALUES ($1, $2)`, [
    resourceId,
    resource.slug,
  ]);
  await client.query(
    `INSERT INTO effect_revisions(
       id, content_release_id, effect_id, scope, stacking_policy, duration_model, rules, active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, TRUE)`,
    [
      revisionId,
      input.releaseId,
      resourceId,
      resource.scope,
      resource.stackingPolicy,
      resource.durationModel,
      JSON.stringify(resource.rules),
    ],
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
      [
        input.releaseId,
        input.resourceId,
        resource.displayName,
        resource.catchRate,
        resource.baseExp,
        JSON.stringify(resource.data),
      ],
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
      [
        input.releaseId,
        input.resourceId,
        resource.displayName,
        resource.typeId,
        resource.category,
        resource.power,
        resource.accuracy,
        resource.priority,
        resource.maxPp,
        resource.effectKey,
        JSON.stringify(resource.effectConfig),
        JSON.stringify(resource.flags),
      ],
    );
    return result.rowCount === 1;
  }
  if (resource.kind === "ITEM") {
    const result = await client.query(
      `UPDATE item_revisions
       SET display_name = $3, item_kind = $4, effect_key = $5, effect_config = $6::jsonb,
           active = TRUE
       WHERE content_release_id = $1 AND item_id = $2`,
      [
        input.releaseId,
        input.resourceId,
        resource.displayName,
        resource.itemKind,
        resource.effectKey,
        JSON.stringify(resource.effectConfig),
      ],
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
    await client.query(`DELETE FROM encounter_entries WHERE encounter_table_revision_id = $1`, [
      revisionId,
    ]);
    await insertEncounterEntries(client, revisionId, resource.entries);
    return true;
  }
  if (resource.kind === "REWARD") {
    await assertRewardReferences(client, input.releaseId, resource.program);
    const result = await client.query(
      `UPDATE reward_revisions
       SET display_name = $3, program = $4::jsonb, active = TRUE
       WHERE content_release_id = $1 AND reward_id = $2`,
      [
        input.releaseId,
        input.resourceId,
        resource.displayName,
        JSON.stringify(resource.program),
      ],
    );
    return result.rowCount === 1;
  }
  const result = await client.query(
    `UPDATE effect_revisions
     SET scope = $3, stacking_policy = $4, duration_model = $5, rules = $6::jsonb,
         active = TRUE
     WHERE content_release_id = $1 AND effect_id = $2`,
    [
      input.releaseId,
      input.resourceId,
      resource.scope,
      resource.stackingPolicy,
      resource.durationModel,
      JSON.stringify(resource.rules),
    ],
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
