import { Pool, type PoolClient } from "pg";
import type { ConnectionAccessRule, WorldAreaConfig } from "../../../src/modules/catalog/world-contracts.js";
import { gen123Id } from "./ids.js";
import { loadGen123Model } from "./model.js";
import { Gen123Source } from "./source.js";
import { GEN123_WORLD_SOURCES, loadGen123WorldTopology } from "./world-source.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) throw new Error("DATABASE_URL is required for Gen I-III world import");

const OPEN_ACCESS: ConnectionAccessRule = { schemaVersion: 1, requiredUnlockKeys: [] };
const STARTING_AREAS = new Set(["pallet-town", "new-bark-town", "littleroot-town"]);

function areaConfig(slug: string): WorldAreaConfig {
  const startingArea = STARTING_AREAS.has(slug);
  const kind = slug.includes("route-")
    ? "ROUTE"
    : slug.endsWith("-city")
      ? "CITY"
      : slug.endsWith("-town")
        ? "TOWN"
        : "OTHER";
  return {
    schemaVersion: 1,
    kind,
    safePoint: startingArea,
    startingArea,
    relocationPriority: startingArea ? 0 : 1000,
  };
}

async function releaseStatus(client: PoolClient, releaseId: string): Promise<string> {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM content_releases WHERE id=$1 FOR UPDATE",
    [releaseId],
  );
  const status = result.rows[0]?.status;
  if (status === undefined) throw new Error("Gen I-III candidate release does not exist");
  return status;
}

async function verifyWorld(
  client: PoolClient,
  releaseId: string,
  expectedLocations: ReadonlySet<string>,
  expectedConnections: number,
): Promise<void> {
  const activeAreas = await client.query<{ slug: string }>(
    `SELECT area.slug
       FROM area_revisions revision
       JOIN areas area ON area.id=revision.area_id
       JOIN regions region ON region.id=area.region_id
      WHERE revision.content_release_id=$1
        AND revision.active
        AND region.slug IN ('kanto','johto','hoenn')
      ORDER BY area.slug`,
    [releaseId],
  );
  const actual = new Set(activeAreas.rows.map((row) => row.slug));
  if (actual.size !== expectedLocations.size)
    throw new Error(`World active area count mismatch: expected ${expectedLocations.size}, got ${actual.size}`);
  for (const slug of expectedLocations)
    if (!actual.has(slug)) throw new Error(`Canonical world area ${slug} is not active`);

  const connections = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM area_connection_revisions revision
      WHERE revision.content_release_id=$1 AND revision.active`,
    [releaseId],
  );
  if ((connections.rows[0]?.count ?? -1) !== expectedConnections)
    throw new Error(
      `World connection count mismatch: expected ${expectedConnections}, got ${connections.rows[0]?.count ?? -1}`,
    );
}

export async function applyGen123World(): Promise<{
  readonly releaseId: string;
  readonly status: string;
  readonly activeAreas: number;
  readonly connections: number;
  readonly sourceLocationCounts: Readonly<Record<string, number>>;
  readonly sourceEdgeCounts: Readonly<Record<string, number>>;
}> {
  const source = Gen123Source.fromEnvironment();
  const model = await loadGen123Model(source);
  const topology = await loadGen123WorldTopology(model.locationRows);
  const releaseId = gen123Id("release:gen123-production-candidate-v1");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const status = await releaseStatus(client, releaseId);
    if (!["DRAFT", "VALIDATED", "PUBLISHED"].includes(status))
      throw new Error(`Unexpected candidate status for world topology: ${status}`);

    if (status !== "DRAFT") {
      await verifyWorld(client, releaseId, topology.locationSlugs, topology.edges.length);
      await client.query("COMMIT");
      return {
        releaseId,
        status,
        activeAreas: topology.locationSlugs.size,
        connections: topology.edges.length,
        sourceLocationCounts: topology.sourceLocationCounts,
        sourceEdgeCounts: topology.sourceEdgeCounts,
      };
    }

    const encounterOutsideScope = await client.query<{ slug: string }>(
      `SELECT DISTINCT area.slug
         FROM encounter_table_revisions table_revision
         JOIN encounter_tables table_identity ON table_identity.id=table_revision.encounter_table_id
         JOIN areas area ON area.id=table_identity.area_id
        WHERE table_revision.content_release_id=$1
          AND table_revision.active
          AND NOT (area.slug = ANY($2::text[]))`,
      [releaseId, [...topology.locationSlugs]],
    );
    if (encounterOutsideScope.rows.length > 0)
      throw new Error(
        `Pinned Gen I-III encounters reference locations absent from the canonical world sources: ${encounterOutsideScope.rows
          .map((row) => row.slug)
          .join(", ")}`,
      );

    const revisions = await client.query<{ id: string; slug: string }>(
      `SELECT revision.id, area.slug
         FROM area_revisions revision
         JOIN areas area ON area.id=revision.area_id
         JOIN regions region ON region.id=area.region_id
        WHERE revision.content_release_id=$1
          AND region.slug IN ('kanto','johto','hoenn')`,
      [releaseId],
    );
    for (const row of revisions.rows) {
      const active = topology.locationSlugs.has(row.slug);
      await client.query(
        `UPDATE area_revisions
            SET active=$2,
                data=$3::jsonb
          WHERE id=$1`,
        [
          row.id,
          active,
          JSON.stringify({
            ...areaConfig(row.slug),
            topology: active
              ? {
                  version: 1,
                  sourcePolicy: "FRLG_KANTO_WITH_CRYSTAL_SUPPLEMENT__CRYSTAL_JOHTO__EMERALD_HOENN",
                  sources: GEN123_WORLD_SOURCES,
                }
              : undefined,
          }),
        ],
      );
    }

    const areaRows = await client.query<{ id: string; slug: string }>(
      `SELECT area.id, area.slug
         FROM areas area
         JOIN regions region ON region.id=area.region_id
        WHERE region.slug IN ('kanto','johto','hoenn')`,
    );
    const idBySlug = new Map<string, string>();
    for (const row of areaRows.rows) {
      if (idBySlug.has(row.slug)) throw new Error(`Duplicate Gen I-III area slug ${row.slug}`);
      idBySlug.set(row.slug, row.id);
    }

    await client.query("DELETE FROM area_connection_revisions WHERE content_release_id=$1", [releaseId]);
    for (const edge of topology.edges) {
      const fromAreaId = idBySlug.get(edge.fromSlug);
      const toAreaId = idBySlug.get(edge.toSlug);
      if (fromAreaId === undefined || toAreaId === undefined)
        throw new Error(`World edge references unresolved area ${edge.fromSlug} -> ${edge.toSlug}`);
      const connectionId = gen123Id(
        `world-connection:${edge.fromSlug}:${edge.toSlug}:${edge.connectionKey}`,
      );
      await client.query(
        `INSERT INTO area_connections(id, from_area_id, to_area_id, connection_key)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (from_area_id,to_area_id,connection_key) DO NOTHING`,
        [connectionId, fromAreaId, toAreaId, edge.connectionKey],
      );
      const resolved = await client.query<{ id: string }>(
        `SELECT id FROM area_connections
          WHERE from_area_id=$1 AND to_area_id=$2 AND connection_key=$3`,
        [fromAreaId, toAreaId, edge.connectionKey],
      );
      const resolvedId = resolved.rows[0]?.id;
      if (resolvedId === undefined) throw new Error("Failed to resolve imported area connection");
      await client.query(
        `INSERT INTO area_connection_revisions(
           id, content_release_id, connection_id, access_rule, active
         ) VALUES ($1,$2,$3,$4::jsonb,TRUE)
         ON CONFLICT (content_release_id,connection_id) DO UPDATE
           SET access_rule=EXCLUDED.access_rule, active=TRUE`,
        [
          gen123Id(`world-connection-revision:${releaseId}:${resolvedId}`),
          releaseId,
          resolvedId,
          JSON.stringify(OPEN_ACCESS),
        ],
      );
    }

    await verifyWorld(client, releaseId, topology.locationSlugs, topology.edges.length);
    await client.query("COMMIT");
    return {
      releaseId,
      status: "DRAFT",
      activeAreas: topology.locationSlugs.size,
      connections: topology.edges.length,
      sourceLocationCounts: topology.sourceLocationCounts,
      sourceEdgeCounts: topology.sourceEdgeCounts,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("world.ts"))
  console.log(JSON.stringify(await applyGen123World(), null, 2));
