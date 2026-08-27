import type { PoolClient } from "pg";
import { ContentLifecycleStatusSchema } from "../../modules/catalog/contracts.js";
import type {
  CatalogDraftInspectInput,
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
    if (row === undefined) return null;
    return {
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
    if (row === undefined) return null;
    return {
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
    if (row === undefined) return null;
    return {
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
      `SELECT identity.slug, identity.region_id, revision.display_name,
              revision.active, revision.data
       FROM areas identity
       JOIN area_revisions revision
         ON revision.area_id = identity.id AND revision.content_release_id = $1
       WHERE identity.id = $2`,
      [input.releaseId, input.resourceId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
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
         ON revision.encounter_table_id = identity.id
        AND revision.content_release_id = $1
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
    if (!tableConditions.success) {
      throw new Error("Persisted encounter table conditions are invalid");
    }
    return {
      ...base,
      active: row.active,
      data: {
        slug: row.slug,
        areaId: row.area_id,
        conditions: tableConditions.data,
        entries: entries.rows.map((entry) => {
          const conditions = parseEncounterConditions(entry.conditions);
          if (!conditions.success) {
            throw new Error("Persisted encounter entry conditions are invalid");
          }
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
    if (row === undefined) return null;
    return {
      ...base,
      active: row.active,
      data: {
        slug: row.slug,
        displayName: row.display_name,
        program: jsonRecord(row.program),
      },
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
  if (row === undefined) return null;
  return {
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
