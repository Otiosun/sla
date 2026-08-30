import { Pool, type PoolClient } from "pg";
import type {
  ConnectionAccessRule,
  WorldAreaConfig,
} from "../../../src/modules/catalog/world-contracts.js";
import { gen123Id } from "./ids.js";
import { loadGen123Model } from "./model.js";
import { Gen123Source, requiredInt, requiredText } from "./source.js";
import { type Gen123WorldEdge, loadGen123WorldTopology } from "./world-source.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined)
  throw new Error("DATABASE_URL is required for Gen I-III world import");

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

function sourceScopedAreas(
  locationRows: readonly Readonly<Record<string, string>>[],
  encounterLocationIds: ReadonlySet<number>,
  topologyLocations: ReadonlySet<string>,
): {
  readonly activeSlugs: ReadonlySet<string>;
  readonly encounterOnlySlugs: ReadonlySet<string>;
} {
  const encounterSlugs = new Set<string>();
  for (const row of locationRows) {
    const locationId = requiredInt(row, "id");
    if (encounterLocationIds.has(locationId)) encounterSlugs.add(requiredText(row, "identifier"));
  }
  const activeSlugs = new Set([...topologyLocations, ...encounterSlugs]);
  const encounterOnlySlugs = new Set(
    [...encounterSlugs].filter((slug) => !topologyLocations.has(slug)),
  );
  return { activeSlugs, encounterOnlySlugs };
}

async function verifyWorld(
  client: PoolClient,
  releaseId: string,
  expectedActiveLocations: ReadonlySet<string>,
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
  if (actual.size !== expectedActiveLocations.size)
    throw new Error(
      `World active area count mismatch: expected ${expectedActiveLocations.size}, got ${actual.size}`,
    );
  for (const slug of expectedActiveLocations)
    if (!actual.has(slug)) throw new Error(`Canonical source-scoped area ${slug} is not active`);

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

export async function reconcileGen123WorldConnections(
  client: PoolClient,
  releaseId: string,
  idBySlug: ReadonlyMap<string, string>,
  edges: readonly Gen123WorldEdge[],
): Promise<void> {
  const expectedConnections: { readonly id: string; readonly edge: Gen123WorldEdge }[] = [];

  for (const edge of edges) {
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
    expectedConnections.push({ id: resolvedId, edge });
  }

  await client.query(
    `UPDATE area_connection_revisions
        SET active=FALSE
      WHERE content_release_id=$1
        AND active
        AND NOT (connection_id = ANY($2::uuid[]))`,
    [
      releaseId,
      expectedConnections.map((connection) => connection.id),
    ],
  );

  for (const connection of expectedConnections) {
    await client.query(
      `INSERT INTO area_connection_revisions(
         id, content_release_id, connection_id, access_rule, active
       ) VALUES ($1,$2,$3,$4::jsonb,TRUE)
       ON CONFLICT (content_release_id,connection_id) DO UPDATE
         SET access_rule=EXCLUDED.access_rule, active=TRUE`,
      [
        gen123Id(`world-connection-revision:${releaseId}:${connection.id}`),
        releaseId,
        connection.id,
        JSON.stringify(OPEN_ACCESS),
      ],
    );
  }
}

export async function applyGen123World(): Promise<{
  readonly releaseId: string;
  readonly status: string;
  readonly activeAreas: number;
  readonly topologyAreas: number;
  readonly encounterOnlyAreas: readonly string[];
  readonly connections: number;
  readonly sourceLocationCounts: Readonly<Record<string, number>>;
  readonly sourceEdgeCounts: Readonly<Record<string, number>>;
}> {
  const source = Gen123Source.fromEnvironment();
  const model = await loadGen123Model(source);
  const topology = await loadGen123WorldTopology(model.locationRows);
  const encounterLocationIds = new Set(model.encounters.map((entry) => entry.locationId));
  const { activeSlugs, encounterOnlySlugs } = sourceScopedAreas(
    model.locationRows,
    encounterLocationIds,
    topology.locationSlugs,
  );
  const releaseId = gen123Id("release:gen123-production-candidate-v1");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const status = await releaseStatus(client, releaseId);
    if (!["DRAFT", "VALIDATED", "PUBLISHED"].includes(status))
      throw new Error(`Unexpected candidate status for world topology: ${status}`);

    if (status !== "DRAFT") {
      await verifyWorld(client, releaseId, activeSlugs, topology.edges.length);
      await client.query("COMMIT");
      return {
        releaseId,
        status,
        activeAreas: activeSlugs.size,
        topologyAreas: topology.locationSlugs.size,
        encounterOnlyAreas: [...encounterOnlySlugs].sort(),
        connections: topology.edges.length,
        sourceLocationCounts: topology.sourceLocationCounts,
        sourceEdgeCounts: topology.sourceEdgeCounts,
      };
    }

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
      const active = activeSlugs.has(row.slug);
      await client.query(
        `UPDATE area_revisions
            SET active=$2,
                data=$3::jsonb
          WHERE id=$1`,
        [row.id, active, JSON.stringify(areaConfig(row.slug))],
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

    await reconcileGen123WorldConnections(client, releaseId, idBySlug, topology.edges);

    await verifyWorld(client, releaseId, activeSlugs, topology.edges.length);
    await client.query("COMMIT");
    return {
      releaseId,
      status: "DRAFT",
      activeAreas: activeSlugs.size,
      topologyAreas: topology.locationSlugs.size,
      encounterOnlyAreas: [...encounterOnlySlugs].sort(),
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
