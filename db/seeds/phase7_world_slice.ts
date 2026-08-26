import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool, type PoolClient } from "pg";
import { CatalogService } from "../../src/modules/catalog/service.js";
import type {
  ConnectionAccessRule,
  WorldAreaConfig,
} from "../../src/modules/catalog/world-contracts.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";
import { withTransaction } from "../../src/platform/db/transaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 7 world-slice seed");
}

const RELEASE_NO = 4n;
const RELEASE_NAME = "Phase 7 World Slice v1";
const EXPECTED_PARENT_RELEASE_NO = 3n;
const REGION_SLUG = "kanto";
const VIRIDIAN_UNLOCK = "world.kanto.viridian-access";

const OPEN_ACCESS: ConnectionAccessRule = {
  schemaVersion: 1,
  requiredUnlockKeys: [],
};
const VIRIDIAN_ACCESS: ConnectionAccessRule = {
  schemaVersion: 1,
  requiredUnlockKeys: [VIRIDIAN_UNLOCK],
};

const PALLET_CONFIG: WorldAreaConfig = {
  schemaVersion: 1,
  kind: "TOWN",
  safePoint: true,
  startingArea: true,
  relocationPriority: 0,
};
const ROUTE_1_CONFIG: WorldAreaConfig = {
  schemaVersion: 1,
  kind: "ROUTE",
  safePoint: false,
  startingArea: false,
  relocationPriority: 100,
};
const VIRIDIAN_CONFIG: WorldAreaConfig = {
  schemaVersion: 1,
  kind: "CITY",
  safePoint: true,
  startingArea: false,
  relocationPriority: 10,
};

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function activeRelease(client: PoolClient): Promise<{ id: string; releaseNo: bigint }> {
  const result = await client.query<{ content_release_id: string; release_no: string }>(
    `SELECT pointer.content_release_id, release.release_no::text
     FROM content_release_pointers pointer
     JOIN content_releases release ON release.id = pointer.content_release_id
     WHERE pointer.pointer_key = 'ACTIVE'`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("An ACTIVE release is required before Phase 7 seed");
  return { id: row.content_release_id, releaseNo: BigInt(row.release_no) };
}

async function resolveRelease(client: PoolClient): Promise<{
  readonly id: string;
  readonly status: "DRAFT" | "VALIDATED" | "PUBLISHED";
  readonly parentReleaseNo: bigint | null;
}> {
  const result = await client.query<{
    id: string;
    status: "DRAFT" | "VALIDATED" | "PUBLISHED";
    name: string;
    parent_release_no: string | null;
  }>(
    `SELECT release.id, release.status, release.name, parent.release_no::text AS parent_release_no
     FROM content_releases release
     LEFT JOIN content_releases parent ON parent.id = release.parent_release_id
     WHERE release.release_no = $1`,
    [RELEASE_NO.toString()],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Phase 7 release was not created");
  if (row.name !== RELEASE_NAME) throw new Error("Release 4 is bound to unexpected content");
  return {
    id: row.id,
    status: row.status,
    parentReleaseNo: row.parent_release_no === null ? null : BigInt(row.parent_release_no),
  };
}

async function resolveRegion(client: PoolClient): Promise<string> {
  const result = await client.query<{ id: string }>("SELECT id FROM regions WHERE slug = $1", [
    REGION_SLUG,
  ]);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("Kanto identity is missing");
  return id;
}

async function ensureArea(client: PoolClient, regionId: string, slug: string): Promise<string> {
  await client.query(
    `INSERT INTO areas(id, region_id, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (region_id, slug) DO NOTHING`,
    [randomUUID(), regionId, slug],
  );
  const result = await client.query<{ id: string }>(
    "SELECT id FROM areas WHERE region_id = $1 AND slug = $2",
    [regionId, slug],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`Failed to resolve area ${slug}`);
  return id;
}

async function ensureAreaRevision(
  client: PoolClient,
  releaseId: string,
  areaId: string,
  displayName: string,
  config: WorldAreaConfig,
): Promise<void> {
  await client.query(
    `INSERT INTO area_revisions(id, content_release_id, area_id, display_name, active, data)
     VALUES ($1, $2, $3, $4, TRUE, $5::jsonb)
     ON CONFLICT (content_release_id, area_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           active = TRUE,
           data = EXCLUDED.data`,
    [randomUUID(), releaseId, areaId, displayName, JSON.stringify(config)],
  );
}

async function ensureConnection(
  client: PoolClient,
  fromAreaId: string,
  toAreaId: string,
  connectionKey: string,
): Promise<string> {
  await client.query(
    `INSERT INTO area_connections(id, from_area_id, to_area_id, connection_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_area_id, to_area_id, connection_key) DO NOTHING`,
    [randomUUID(), fromAreaId, toAreaId, connectionKey],
  );
  const result = await client.query<{ id: string }>(
    `SELECT id FROM area_connections
     WHERE from_area_id = $1 AND to_area_id = $2 AND connection_key = $3`,
    [fromAreaId, toAreaId, connectionKey],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`Failed to resolve connection ${connectionKey}`);
  return id;
}

async function ensureConnectionRevision(
  client: PoolClient,
  releaseId: string,
  connectionId: string,
  accessRule: ConnectionAccessRule,
): Promise<void> {
  await client.query(
    `INSERT INTO area_connection_revisions(
       id, content_release_id, connection_id, access_rule, active
     ) VALUES ($1, $2, $3, $4::jsonb, TRUE)
     ON CONFLICT (content_release_id, connection_id) DO UPDATE
       SET access_rule = EXCLUDED.access_rule,
           active = TRUE`,
    [randomUUID(), releaseId, connectionId, JSON.stringify(accessRule)],
  );
}

async function seedWorld(client: PoolClient, releaseId: string): Promise<void> {
  const regionId = await resolveRegion(client);
  const palletId = await ensureArea(client, regionId, "pallet-town");
  const route1Id = await ensureArea(client, regionId, "route-1");
  const viridianId = await ensureArea(client, regionId, "viridian-city");

  await ensureAreaRevision(client, releaseId, palletId, "Pallet Town", PALLET_CONFIG);
  await ensureAreaRevision(client, releaseId, route1Id, "Route 1", ROUTE_1_CONFIG);
  await ensureAreaRevision(client, releaseId, viridianId, "Viridian City", VIRIDIAN_CONFIG);

  const connections = [
    [palletId, route1Id, "north", OPEN_ACCESS],
    [route1Id, palletId, "south", OPEN_ACCESS],
    [route1Id, viridianId, "north", VIRIDIAN_ACCESS],
    [viridianId, route1Id, "south", OPEN_ACCESS],
  ] as const;
  for (const [fromAreaId, toAreaId, connectionKey, accessRule] of connections) {
    const connectionId = await ensureConnection(client, fromAreaId, toAreaId, connectionKey);
    await ensureConnectionRevision(client, releaseId, connectionId, accessRule);
  }
}

async function verifyWorld(client: PoolClient, releaseId: string): Promise<void> {
  const areas = await client.query<{
    slug: string;
    display_name: string;
    data: unknown;
    active: boolean;
  }>(
    `SELECT area.slug, revision.display_name, revision.data, revision.active
     FROM area_revisions revision
     JOIN areas area ON area.id = revision.area_id
     JOIN regions region ON region.id = area.region_id
     WHERE revision.content_release_id = $1 AND region.slug = $2
     ORDER BY area.slug`,
    [releaseId, REGION_SLUG],
  );
  const expectedAreas = [
    { slug: "pallet-town", display_name: "Pallet Town", data: PALLET_CONFIG, active: true },
    { slug: "route-1", display_name: "Route 1", data: ROUTE_1_CONFIG, active: true },
    { slug: "viridian-city", display_name: "Viridian City", data: VIRIDIAN_CONFIG, active: true },
  ];
  if (!isDeepStrictEqual(areas.rows, expectedAreas)) {
    throw new Error(`Phase 7 areas differ from canonical seed: ${JSON.stringify(areas.rows)}`);
  }

  const connections = await client.query<{
    from_slug: string;
    to_slug: string;
    connection_key: string;
    access_rule: unknown;
    active: boolean;
  }>(
    `SELECT source.slug AS from_slug, destination.slug AS to_slug,
            connection.connection_key, revision.access_rule, revision.active
     FROM area_connection_revisions revision
     JOIN area_connections connection ON connection.id = revision.connection_id
     JOIN areas source ON source.id = connection.from_area_id
     JOIN areas destination ON destination.id = connection.to_area_id
     WHERE revision.content_release_id = $1
     ORDER BY source.slug, destination.slug, connection.connection_key`,
    [releaseId],
  );
  const expectedConnections = [
    {
      from_slug: "pallet-town",
      to_slug: "route-1",
      connection_key: "north",
      access_rule: OPEN_ACCESS,
      active: true,
    },
    {
      from_slug: "route-1",
      to_slug: "pallet-town",
      connection_key: "south",
      access_rule: OPEN_ACCESS,
      active: true,
    },
    {
      from_slug: "route-1",
      to_slug: "viridian-city",
      connection_key: "north",
      access_rule: VIRIDIAN_ACCESS,
      active: true,
    },
    {
      from_slug: "viridian-city",
      to_slug: "route-1",
      connection_key: "south",
      access_rule: OPEN_ACCESS,
      active: true,
    },
  ];
  if (!isDeepStrictEqual(connections.rows, expectedConnections)) {
    throw new Error(
      `Phase 7 connections differ from canonical seed: ${JSON.stringify(connections.rows)}`,
    );
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const migrations = await loadMigrations();
    const verifyClient = await pool.connect();
    try {
      await verifyAppliedMigrations(verifyClient, migrations, true);
    } finally {
      verifyClient.release();
    }

    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    let release = await withTransaction(pool, async (client) => {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM content_releases WHERE release_no = $1",
        [RELEASE_NO.toString()],
      );
      if (existing.rows[0] !== undefined) return resolveRelease(client);

      const parent = await activeRelease(client);
      if (parent.releaseNo !== EXPECTED_PARENT_RELEASE_NO) {
        throw new Error(
          `Phase 7 seed expects ACTIVE release ${EXPECTED_PARENT_RELEASE_NO}, got ${parent.releaseNo}`,
        );
      }
      const newReleaseId = randomUUID();
      unwrap(
        "clone Phase 6 release",
        await catalog.clonePublishedRelease({
          parentReleaseId: parent.id,
          newReleaseId,
          releaseNo: RELEASE_NO,
          name: RELEASE_NAME,
        }),
      );
      return resolveRelease(client);
    });

    if (release.parentReleaseNo !== EXPECTED_PARENT_RELEASE_NO) {
      throw new Error(
        `Phase 7 release has unexpected parent release ${String(release.parentReleaseNo)}`,
      );
    }

    if (release.status === "DRAFT") {
      await withTransaction(pool, async (client) => {
        await seedWorld(client, release.id);
        await verifyWorld(client, release.id);
      });
      unwrap("validate Phase 7 release", await catalog.validateRelease(release.id));
      release = await withTransaction(pool, resolveRelease);
    }
    if (release.status === "VALIDATED") {
      unwrap("publish Phase 7 release", await catalog.publishRelease(release.id));
      release = await withTransaction(pool, resolveRelease);
    }
    if (release.status !== "PUBLISHED") {
      throw new Error(`Unexpected Phase 7 status: ${release.status}`);
    }

    unwrap("activate Phase 7 release", await catalog.activateRelease(release.id));
    await withTransaction(pool, async (client) => verifyWorld(client, release.id));
    console.log(`Phase 7 world slice ready: release ${release.id}`);
  } finally {
    await pool.end();
  }
}

await main();
