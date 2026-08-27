import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ContentLifecycleStatusSchema } from "../../modules/catalog/contracts.js";
import type {
  CatalogDraftCreateInput,
  CatalogDraftDeactivateInput,
  CatalogDraftEncounterEntrySchema,
  CatalogDraftInspectInput,
  CatalogDraftMutationResult,
  CatalogDraftReplaceInput,
  CatalogDraftResourceKind,
  CatalogDraftResourceView,
} from "../../modules/catalog/draft-contracts.js";
import type {
  CatalogDraftOwnerMutationContext,
  CatalogDraftPersistenceResult,
  CatalogDraftRepository,
} from "../../modules/catalog/draft-service.js";
import { parseEncounterConditions } from "../../modules/catalog/encounter-contracts.js";
import { withTransaction } from "../db/transaction.js";

interface ReleaseRow {
  readonly status: string;
  readonly revision: string;
}

interface ClaimRow {
  readonly operation_kind: string;
  readonly content_release_id: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly request_fingerprint: string;
  readonly result: unknown;
}

type MutationEnvelope = CatalogDraftOwnerMutationContext & {
  readonly releaseId: string;
  readonly requestFingerprint: string;
};

function safeRevision(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error("Catalog release revision cannot be negative");
  return parsed;
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object from catalog persistence");
  }
  return value as Readonly<Record<string, unknown>>;
}

function replayResult(value: unknown): CatalogDraftMutationResult {
  const record = jsonRecord(value);
  if (
    (record.operationKind !== "CREATE" &&
      record.operationKind !== "REPLACE" &&
      record.operationKind !== "DEACTIVATE") ||
    typeof record.resourceKind !== "string" ||
    typeof record.resourceId !== "string" ||
    typeof record.beforeRevision !== "string" ||
    typeof record.afterRevision !== "string" ||
    typeof record.afterData !== "object" ||
    record.afterData === null
  ) {
    throw new Error("Catalog admin claim contains invalid replay evidence");
  }
  return {
    operationKind: record.operationKind,
    resourceKind: record.resourceKind as CatalogDraftResourceKind,
    resourceId: record.resourceId,
    beforeRevision: record.beforeRevision,
    afterRevision: record.afterRevision,
    beforeData:
      record.beforeData === null || record.beforeData === undefined
        ? null
        : jsonRecord(record.beforeData),
    afterData: jsonRecord(record.afterData),
    replayed: true,
  };
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

async function loadRelease(
  client: PoolClient,
  releaseId: string,
  lock = false,
): Promise<ReleaseRow | null> {
  const result = await client.query<ReleaseRow>(
    `SELECT status, revision::text
     FROM content_releases
     WHERE id = $1
     ${lock ? "FOR UPDATE" : ""}`,
    [releaseId],
  );
  return result.rows[0] ?? null;
}

async function replayClaim(
  client: PoolClient,
  input: {
    readonly releaseId: string;
    readonly operationKind: "CREATE" | "REPLACE" | "DEACTIVATE";
    readonly resourceKind: CatalogDraftResourceKind;
    readonly resourceId: string | null;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  },
): Promise<CatalogDraftPersistenceResult | null> {
  const result = await client.query<ClaimRow>(
    `SELECT operation_kind, content_release_id, resource_kind, resource_id,
            request_fingerprint, result
     FROM catalog_admin_operation_claims
     WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (
    row.operation_kind !== input.operationKind ||
    row.content_release_id !== input.releaseId ||
    row.resource_kind !== input.resourceKind ||
    (input.resourceId !== null && row.resource_id !== input.resourceId) ||
    row.request_fingerprint !== input.requestFingerprint
  ) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  return { kind: "REPLAYED", result: replayResult(row.result) };
}

async function inspectResource(
  client: PoolClient,
  input: CatalogDraftInspectInput,
): Promise<CatalogDraftResourceView | null> {
  const release = await loadRelease(client, input.releaseId);
  if (release === null) return null;
  const releaseStatus = ContentLifecycleStatusSchema.parse(release.status);
  const releaseRevision = release.revision;
  const common = {
    releaseId: input.releaseId,
    releaseRevision,
    releaseStatus,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
  } as const;

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
      ...common,
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
      ...common,
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
      ...common,
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
    if (row === undefined) return null;
    return {
      ...common,
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
      ...common,
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
    if (row === undefined) return null;
    return {
      ...common,
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
  if (row === undefined) return null;
  return {
    ...common,
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
  entries: readonly (typeof CatalogDraftEncounterEntrySchema)["_output"][],
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

async function createResource(
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
    await client.query(`INSERT INTO moves(id, slug) VALUES ($1, $2)`, [resourceId, resource.slug]);
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
    await client.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [resourceId, resource.slug]);
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
      [revisionId, input.releaseId, resourceId, resource.displayName, JSON.stringify(resource.data)],
    );
    return;
  }
  if (resource.kind === "ENCOUNTER_TABLE") {
    await client.query(`INSERT INTO encounter_tables(id, area_id, slug) VALUES ($1, $2, $3)`, [
      resourceId,
      resource.areaId,
      resource.slug,
    ]);
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
    await client.query(`INSERT INTO reward_definitions(id, slug) VALUES ($1, $2)`, [
      resourceId,
      resource.slug,
    ]);
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

async function replaceResource(
  client: PoolClient,
  input: CatalogDraftReplaceInput,
): Promise<boolean> {
  const resource = input.resource;
  let result;
  if (resource.kind === "SPECIES") {
    result = await client.query(
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
  } else if (resource.kind === "MOVE") {
    result = await client.query(
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
  } else if (resource.kind === "ITEM") {
    result = await client.query(
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
  } else if (resource.kind === "AREA") {
    result = await client.query(
      `UPDATE area_revisions
       SET display_name = $3, data = $4::jsonb, active = TRUE
       WHERE content_release_id = $1 AND area_id = $2`,
      [input.releaseId, input.resourceId, resource.displayName, JSON.stringify(resource.data)],
    );
  } else if (resource.kind === "ENCOUNTER_TABLE") {
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
  } else if (resource.kind === "REWARD") {
    result = await client.query(
      `UPDATE reward_revisions
       SET display_name = $3, program = $4::jsonb, active = TRUE
       WHERE content_release_id = $1 AND reward_id = $2`,
      [input.releaseId, input.resourceId, resource.displayName, JSON.stringify(resource.program)],
    );
  } else {
    result = await client.query(
      `UPDATE effect_revisions
       SET scope = $3, stacking_policy = $4, duration_model = $5, rules = $6::jsonb, active = TRUE
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
  }
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

async function deactivateResource(
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

function resourceKindFromCreate(input: CatalogDraftCreateInput): CatalogDraftResourceKind {
  return input.resource.kind;
}

function resourceKindFromReplace(input: CatalogDraftReplaceInput): CatalogDraftResourceKind {
  return input.resource.kind;
}

function pgCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

export class PostgresCatalogDraftRepository implements CatalogDraftRepository {
  public constructor(private readonly pool: Pool) {}

  public async inspect(input: CatalogDraftInspectInput): Promise<CatalogDraftResourceView | null> {
    return withTransaction(this.pool, (client) => inspectResource(client, input), {
      isolationLevel: "REPEATABLE READ",
      readOnly: true,
    });
  }

  public async create(
    input: CatalogDraftCreateInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult> {
    const resourceId = randomUUID();
    const kind = resourceKindFromCreate(input);
    try {
      return await this.mutate(
        input,
        "CREATE",
        kind,
        resourceId,
        async (client) => createResource(client, input, resourceId),
      );
    } catch (error) {
      const code = pgCode(error);
      if (code === "23505") return { kind: "RESOURCE_CONFLICT", reason: "Catalog identity already exists" };
      if (code === "23503" || code === "23514") {
        return { kind: "INVALID_RESOURCE", reason: "Catalog resource violates a persisted reference or constraint" };
      }
      throw error;
    }
  }

  public async replace(
    input: CatalogDraftReplaceInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult> {
    try {
      return await this.mutate(
        input,
        "REPLACE",
        resourceKindFromReplace(input),
        input.resourceId,
        async (client) => {
          if (!(await replaceResource(client, input))) throw new ResourceMissingError();
        },
      );
    } catch (error) {
      if (error instanceof ResourceMissingError) return { kind: "NOT_FOUND" };
      const code = pgCode(error);
      if (code === "23503" || code === "23514") {
        return { kind: "INVALID_RESOURCE", reason: "Catalog replacement violates a persisted reference or constraint" };
      }
      throw error;
    }
  }

  public async deactivate(
    input: CatalogDraftDeactivateInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult> {
    try {
      return await this.mutate(
        input,
        "DEACTIVATE",
        input.resourceKind,
        input.resourceId,
        async (client) => {
          if (!(await deactivateResource(client, input))) throw new ResourceMissingError();
        },
      );
    } catch (error) {
      if (error instanceof ResourceMissingError) return { kind: "NOT_FOUND" };
      throw error;
    }
  }

  private async mutate(
    input: MutationEnvelope,
    operationKind: "CREATE" | "REPLACE" | "DEACTIVATE",
    resourceKind: CatalogDraftResourceKind,
    resourceId: string,
    mutation: (client: PoolClient) => Promise<void>,
  ): Promise<CatalogDraftPersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `catalog-release:${input.releaseId}`,
        `catalog-admin:${input.idempotencyKey}`,
      ]);
      const replay = await replayClaim(client, {
        releaseId: input.releaseId,
        operationKind,
        resourceKind,
        resourceId: operationKind === "CREATE" ? null : resourceId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      });
      if (replay !== null) return replay;

      const release = await loadRelease(client, input.releaseId, true);
      if (release === null) return { kind: "NOT_FOUND" };
      if (release.status !== "DRAFT") return { kind: "NOT_DRAFT", status: release.status };
      const beforeRevision = safeRevision(release.revision);
      if (beforeRevision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }

      const before =
        operationKind === "CREATE"
          ? null
          : await inspectResource(client, {
              releaseId: input.releaseId,
              resourceKind,
              resourceId,
            });
      if (operationKind !== "CREATE" && before === null) return { kind: "NOT_FOUND" };

      await mutation(client);
      const advanced = await client.query<{ revision: string }>(
        `UPDATE content_releases
         SET revision = revision + 1
         WHERE id = $1 AND status = 'DRAFT' AND revision = $2
         RETURNING revision::text`,
        [input.releaseId, beforeRevision.toString()],
      );
      const afterRevisionText = advanced.rows[0]?.revision;
      if (afterRevisionText === undefined) {
        const fresh = await loadRelease(client, input.releaseId);
        return {
          kind: "REVISION_CONFLICT",
          actualRevision: fresh === null ? beforeRevision : safeRevision(fresh.revision),
        };
      }
      const afterRevision = safeRevision(afterRevisionText);
      const after = await inspectResource(client, {
        releaseId: input.releaseId,
        resourceKind,
        resourceId,
      });
      if (after === null) throw new Error("Catalog draft resource disappeared after mutation");

      const result: CatalogDraftMutationResult = {
        operationKind,
        resourceKind,
        resourceId,
        beforeRevision: beforeRevision.toString(),
        afterRevision: afterRevision.toString(),
        beforeData: before,
        afterData: after,
        replayed: false,
      };
      await client.query(
        `INSERT INTO catalog_admin_operation_claims(
           id, operation_kind, content_release_id, resource_kind, resource_id,
           idempotency_key, request_fingerprint, before_revision, after_revision,
           before_data, after_data, result, correlation_id
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10::jsonb, $11::jsonb, $12::jsonb, $13
         )`,
        [
          randomUUID(),
          operationKind,
          input.releaseId,
          resourceKind,
          resourceId,
          input.idempotencyKey,
          input.requestFingerprint,
          beforeRevision.toString(),
          afterRevision.toString(),
          before === null ? null : JSON.stringify(before),
          JSON.stringify(after),
          JSON.stringify(result),
          input.correlationId,
        ],
      );
      return { kind: "PERSISTED", result };
    });
  }
}

class ResourceMissingError extends Error {}
