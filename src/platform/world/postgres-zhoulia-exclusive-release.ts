import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  buildZhouliaDirectedRoutes,
  zhouliaAreaSlug,
} from "../../modules/world/zhoulia-catalog-adapter.js";
import {
  validateZhouliaContentBundle,
  ZHOULIA_TYPED_CONTENT_V1,
  type ZhouliaContentBundle,
} from "../../modules/world/zhoulia-content.js";
import { buildBalancedZhouliaEncounterPlans } from "../../modules/world/zhoulia-encounter-balance.js";
import { PostgresZhouliaDraftStructureImporter } from "./postgres-zhoulia-draft-importer.js";
import { PostgresZhouliaEncounterDraftMaterializer } from "./postgres-zhoulia-encounter-materializer.js";

export interface ZhouliaStarterOptionInput {
  readonly formId: string;
  readonly starterLevel: number;
  readonly sortOrder: number;
}

export interface ZhouliaExclusiveReleaseReport {
  readonly releaseId: string;
  readonly regionId: string;
  readonly activeAreaSlugs: readonly string[];
  readonly activeConnectionKeys: readonly string[];
  readonly activeEncounterTables: readonly string[];
  readonly activeStarterCount: number;
}

function assertSameStrings(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(right)}, got ${JSON.stringify(left)}`,
    );
  }
}

async function requireDraftRelease(client: PoolClient, releaseId: string): Promise<void> {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM content_releases WHERE id=$1 FOR UPDATE",
    [releaseId],
  );
  const status = result.rows[0]?.status;
  if (status === undefined) throw new Error(`Content release ${releaseId} does not exist`);
  if (status !== "DRAFT") {
    throw new Error(`Zhoulia exclusive reconciliation requires DRAFT; found ${status}`);
  }
}

async function deactivateInheritedWorld(client: PoolClient, releaseId: string): Promise<void> {
  await client.query(
    `UPDATE encounter_entries entry
        SET active=FALSE
       FROM encounter_table_revisions revision
      WHERE revision.id=entry.encounter_table_revision_id
        AND revision.content_release_id=$1
        AND entry.active=TRUE`,
    [releaseId],
  );
  await client.query(
    "UPDATE encounter_table_revisions SET active=FALSE WHERE content_release_id=$1 AND active=TRUE",
    [releaseId],
  );
  await client.query(
    "UPDATE area_connection_revisions SET active=FALSE WHERE content_release_id=$1 AND active=TRUE",
    [releaseId],
  );
  await client.query(
    "UPDATE area_revisions SET active=FALSE WHERE content_release_id=$1 AND active=TRUE",
    [releaseId],
  );
  await client.query(
    "UPDATE region_revisions SET active=FALSE WHERE content_release_id=$1 AND active=TRUE",
    [releaseId],
  );
  await client.query(
    "UPDATE starter_options SET active=FALSE WHERE content_release_id=$1 AND active=TRUE",
    [releaseId],
  );
}

function validateExplicitStarterOptions(starters: readonly ZhouliaStarterOptionInput[]): void {
  if (starters.length === 0) {
    throw new Error("Zhoulia reconciliation requires explicit starter options");
  }
  const formIds = new Set<string>();
  const sortOrders = new Set<number>();
  for (const starter of starters) {
    if (!Number.isInteger(starter.starterLevel) || starter.starterLevel <= 0) {
      throw new Error(`Invalid Zhoulia starter level for form ${starter.formId}`);
    }
    if (!Number.isInteger(starter.sortOrder) || starter.sortOrder < 0) {
      throw new Error(`Invalid Zhoulia starter sort order for form ${starter.formId}`);
    }
    if (formIds.has(starter.formId)) {
      throw new Error(`Duplicate Zhoulia starter form ${starter.formId}`);
    }
    if (sortOrders.has(starter.sortOrder)) {
      throw new Error(`Duplicate Zhoulia starter sort order ${starter.sortOrder}`);
    }
    formIds.add(starter.formId);
    sortOrders.add(starter.sortOrder);
  }
}

async function applyExplicitStarters(
  pool: Pool,
  releaseId: string,
  regionId: string,
  starters: readonly ZhouliaStarterOptionInput[],
): Promise<void> {
  validateExplicitStarterOptions(starters);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `catalog-release:${releaseId}`,
    ]);
    await requireDraftRelease(client, releaseId);
    const region = await client.query<{ active: boolean }>(
      `SELECT revision.active
         FROM region_revisions revision
         JOIN regions region ON region.id=revision.region_id
        WHERE revision.content_release_id=$1
          AND revision.region_id=$2
          AND region.slug='zhoulia'`,
      [releaseId, regionId],
    );
    if (region.rows[0]?.active !== true) {
      throw new Error("Zhoulia region must be active before starter reconciliation");
    }

    const ordered = [...starters].sort(
      (left, right) => left.sortOrder - right.sortOrder || left.formId.localeCompare(right.formId),
    );
    const activeForms = await client.query<{ form_id: string }>(
      `SELECT form_id
         FROM pokemon_form_revisions
        WHERE content_release_id=$1
          AND active=TRUE
          AND form_id=ANY($2::uuid[])`,
      [releaseId, ordered.map((starter) => starter.formId)],
    );
    const activeFormIds = new Set(activeForms.rows.map((row) => row.form_id));
    const missingFormIds = ordered
      .map((starter) => starter.formId)
      .filter((formId) => !activeFormIds.has(formId));
    if (missingFormIds.length > 0) {
      throw new Error(
        `Zhoulia starter forms are not active in release ${releaseId}: ${missingFormIds.join(",")}`,
      );
    }

    for (const starter of ordered) {
      await client.query(
        `INSERT INTO starter_options(
           id,content_release_id,region_id,form_id,starter_level,sort_order,active
         ) VALUES ($1,$2,$3,$4,$5,$6,TRUE)
         ON CONFLICT (content_release_id,region_id,form_id)
         DO UPDATE SET starter_level=EXCLUDED.starter_level,
                       sort_order=EXCLUDED.sort_order,
                       active=TRUE`,
        [
          randomUUID(),
          releaseId,
          regionId,
          starter.formId,
          starter.starterLevel,
          starter.sortOrder,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function assertZhouliaExclusiveRelease(
  pool: Pool,
  input: {
    readonly releaseId: string;
    readonly bundle?: ZhouliaContentBundle;
  },
): Promise<ZhouliaExclusiveReleaseReport> {
  const bundle = input.bundle ?? ZHOULIA_TYPED_CONTENT_V1;
  validateZhouliaContentBundle(bundle);

  const regions = await pool.query<{ id: string; slug: string }>(
    `SELECT region.id, region.slug
       FROM region_revisions revision
       JOIN regions region ON region.id=revision.region_id
      WHERE revision.content_release_id=$1
        AND revision.active=TRUE
      ORDER BY region.slug`,
    [input.releaseId],
  );
  assertSameStrings(
    "active region slugs",
    regions.rows.map((row) => row.slug),
    ["zhoulia"],
  );
  const regionId = regions.rows[0]?.id;
  if (regionId === undefined) throw new Error("Active Zhoulia region is missing");

  const areas = await pool.query<{ slug: string; starting_area: boolean }>(
    `SELECT area.slug,
            COALESCE((revision.data->>'startingArea')::boolean,FALSE) AS starting_area
       FROM area_revisions revision
       JOIN areas area ON area.id=revision.area_id
       JOIN regions region ON region.id=area.region_id
      WHERE revision.content_release_id=$1
        AND revision.active=TRUE
      ORDER BY area.slug`,
    [input.releaseId],
  );
  const expectedAreaSlugs = bundle.areas.map(zhouliaAreaSlug).sort();
  assertSameStrings(
    "active area slugs",
    areas.rows.map((row) => row.slug),
    expectedAreaSlugs,
  );
  const startingAreas = areas.rows.filter((row) => row.starting_area).map((row) => row.slug);
  assertSameStrings("starting area", startingAreas, ["vila-dos-arrozais"]);

  const connections = await pool.query<{ connection_key: string }>(
    `SELECT connection.connection_key
       FROM area_connection_revisions revision
       JOIN area_connections connection ON connection.id=revision.connection_id
       JOIN areas source ON source.id=connection.from_area_id
       JOIN regions source_region ON source_region.id=source.region_id
       JOIN areas destination ON destination.id=connection.to_area_id
       JOIN regions destination_region ON destination_region.id=destination.region_id
      WHERE revision.content_release_id=$1
        AND revision.active=TRUE
        AND source_region.slug='zhoulia'
        AND destination_region.slug='zhoulia'
      ORDER BY connection.connection_key`,
    [input.releaseId],
  );
  const expectedConnectionKeys = buildZhouliaDirectedRoutes(bundle)
    .map((route) => route.connectionKey)
    .sort();
  assertSameStrings(
    "active Zhoulia connection keys",
    connections.rows.map((row) => row.connection_key),
    expectedConnectionKeys,
  );

  const foreignConnections = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM area_connection_revisions revision
       JOIN area_connections connection ON connection.id=revision.connection_id
       JOIN areas source ON source.id=connection.from_area_id
       JOIN regions source_region ON source_region.id=source.region_id
       JOIN areas destination ON destination.id=connection.to_area_id
       JOIN regions destination_region ON destination_region.id=destination.region_id
      WHERE revision.content_release_id=$1
        AND revision.active=TRUE
        AND (source_region.slug<>'zhoulia' OR destination_region.slug<>'zhoulia')`,
    [input.releaseId],
  );
  if ((foreignConnections.rows[0]?.count ?? 0) !== 0) {
    throw new Error("Foreign active world connections remain after Zhoulia reconciliation");
  }

  const encounterTables = await pool.query<{
    region_slug: string;
    area_slug: string;
    table_slug: string;
  }>(
    `SELECT region.slug AS region_slug, area.slug AS area_slug, table_identity.slug AS table_slug
       FROM encounter_table_revisions revision
       JOIN encounter_tables table_identity ON table_identity.id=revision.encounter_table_id
       JOIN areas area ON area.id=table_identity.area_id
       JOIN regions region ON region.id=area.region_id
      WHERE revision.content_release_id=$1
        AND revision.active=TRUE
      ORDER BY region.slug,area.slug,table_identity.slug`,
    [input.releaseId],
  );
  const expectedEncounterTables = buildBalancedZhouliaEncounterPlans(bundle)
    .map((plan) => `${plan.areaIdentity.split(".").at(-1)}:${plan.tableSlug}`)
    .sort();
  const actualEncounterTables = encounterTables.rows.map(
    (row) => `${row.area_slug}:${row.table_slug}`,
  );
  assertSameStrings("active encounter tables", actualEncounterTables, expectedEncounterTables);
  if (encounterTables.rows.some((row) => row.region_slug !== "zhoulia")) {
    throw new Error("Foreign active encounter table remains after Zhoulia reconciliation");
  }

  const activeEntriesOnInactiveTables = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM encounter_entries entry
       JOIN encounter_table_revisions revision
         ON revision.id=entry.encounter_table_revision_id
      WHERE revision.content_release_id=$1
        AND entry.active=TRUE
        AND revision.active=FALSE`,
    [input.releaseId],
  );
  if ((activeEntriesOnInactiveTables.rows[0]?.count ?? 0) !== 0) {
    throw new Error("Active encounter entries remain attached to inactive world tables");
  }

  const starters = await pool.query<{ region_slug: string }>(
    `SELECT region.slug AS region_slug
       FROM starter_options option
       JOIN regions region ON region.id=option.region_id
      WHERE option.content_release_id=$1
        AND option.active=TRUE
      ORDER BY option.sort_order,option.form_id`,
    [input.releaseId],
  );
  if (starters.rows.length === 0) {
    throw new Error("Zhoulia release has no active starter options");
  }
  if (starters.rows.some((row) => row.region_slug !== "zhoulia")) {
    throw new Error("Active starter option points to a region other than Zhoulia");
  }

  return {
    releaseId: input.releaseId,
    regionId,
    activeAreaSlugs: areas.rows.map((row) => row.slug),
    activeConnectionKeys: connections.rows.map((row) => row.connection_key),
    activeEncounterTables: actualEncounterTables,
    activeStarterCount: starters.rows.length,
  };
}

export async function reconcileZhouliaExclusiveRelease(
  pool: Pool,
  input: {
    readonly releaseId: string;
    readonly starterOptions: readonly ZhouliaStarterOptionInput[];
    readonly bundle?: ZhouliaContentBundle;
  },
): Promise<ZhouliaExclusiveReleaseReport> {
  const bundle = input.bundle ?? ZHOULIA_TYPED_CONTENT_V1;
  validateZhouliaContentBundle(bundle);
  validateExplicitStarterOptions(input.starterOptions);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `catalog-release:${input.releaseId}`,
    ]);
    await requireDraftRelease(client, input.releaseId);
    await deactivateInheritedWorld(client, input.releaseId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const structure = await new PostgresZhouliaDraftStructureImporter(pool).import({
    releaseId: input.releaseId,
    bundle,
  });
  await applyExplicitStarters(pool, input.releaseId, structure.regionId, input.starterOptions);
  await new PostgresZhouliaEncounterDraftMaterializer(pool).materialize({
    releaseId: input.releaseId,
    bundle,
  });

  return assertZhouliaExclusiveRelease(pool, {
    releaseId: input.releaseId,
    bundle,
  });
}
