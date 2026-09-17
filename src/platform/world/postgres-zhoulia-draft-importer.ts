import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  buildZhouliaDirectedRoutes,
  buildZhouliaEncounterPoolDraftPlans,
  zhouliaAreaSlug,
  zhouliaWorldAreaConfig,
} from "../../modules/world/zhoulia-catalog-adapter.js";
import {
  validateZhouliaContentBundle,
  ZHOULIA_TYPED_CONTENT_V1,
  type ZhouliaContentBundle,
  zhouliaContentFingerprint,
} from "../../modules/world/zhoulia-content.js";

export interface ZhouliaDraftStructureImportResult {
  readonly releaseId: string;
  readonly regionId: string;
  readonly bundleFingerprint: string;
  readonly areaIdsByIdentity: Readonly<Record<string, string>>;
  readonly directedConnectionCount: number;
  readonly encounterPoolsPendingBalance: readonly {
    readonly identity: string;
    readonly areaIdentity: string;
    readonly speciesKeys: readonly string[];
  }[];
}

async function requireDraftRelease(client: PoolClient, releaseId: string): Promise<void> {
  const release = await client.query<{ status: string }>(
    "SELECT status FROM content_releases WHERE id = $1 FOR UPDATE",
    [releaseId],
  );
  const status = release.rows[0]?.status;
  if (status === undefined) throw new Error(`Content release ${releaseId} does not exist`);
  if (status !== "DRAFT") {
    throw new Error(`Zhoulia structure import requires a DRAFT content release; found ${status}`);
  }
}

async function resolveZhouliaRegion(client: PoolClient, releaseId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT region.id
     FROM regions AS region
     JOIN region_revisions AS revision
       ON revision.region_id = region.id
      AND revision.content_release_id = $1
     WHERE region.slug = 'zhoulia'
       AND revision.active = TRUE
     LIMIT 1`,
    [releaseId],
  );
  const regionId = result.rows[0]?.id;
  if (regionId === undefined) {
    throw new Error("DRAFT release must contain an active Zhoulia region revision");
  }
  return regionId;
}

async function ensureArea(
  client: PoolClient,
  input: {
    readonly releaseId: string;
    readonly regionId: string;
    readonly slug: string;
    readonly displayName: string;
    readonly data: unknown;
  },
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM areas WHERE region_id = $1 AND slug = $2",
    [input.regionId, input.slug],
  );
  const areaId = existing.rows[0]?.id ?? randomUUID();

  if (existing.rows[0] === undefined) {
    await client.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
      areaId,
      input.regionId,
      input.slug,
    ]);
  }

  const revision = await client.query<{ id: string }>(
    `SELECT id FROM area_revisions
     WHERE content_release_id = $1 AND area_id = $2`,
    [input.releaseId, areaId],
  );

  if (revision.rows[0] === undefined) {
    await client.query(
      `INSERT INTO area_revisions(
         id, content_release_id, area_id, display_name, active, data
       ) VALUES ($1, $2, $3, $4, TRUE, $5::jsonb)`,
      [randomUUID(), input.releaseId, areaId, input.displayName, JSON.stringify(input.data)],
    );
  } else {
    await client.query(
      `UPDATE area_revisions
       SET display_name = $3, active = TRUE, data = $4::jsonb
       WHERE content_release_id = $1 AND area_id = $2`,
      [input.releaseId, areaId, input.displayName, JSON.stringify(input.data)],
    );
  }

  return areaId;
}

async function ensureConnection(
  client: PoolClient,
  input: {
    readonly releaseId: string;
    readonly fromAreaId: string;
    readonly toAreaId: string;
    readonly connectionKey: string;
    readonly accessRule: unknown;
  },
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM area_connections
     WHERE from_area_id = $1 AND to_area_id = $2 AND connection_key = $3`,
    [input.fromAreaId, input.toAreaId, input.connectionKey],
  );
  const connectionId = existing.rows[0]?.id ?? randomUUID();

  if (existing.rows[0] === undefined) {
    await client.query(
      `INSERT INTO area_connections(id, from_area_id, to_area_id, connection_key)
       VALUES ($1, $2, $3, $4)`,
      [connectionId, input.fromAreaId, input.toAreaId, input.connectionKey],
    );
  }

  const revision = await client.query<{ id: string }>(
    `SELECT id FROM area_connection_revisions
     WHERE content_release_id = $1 AND connection_id = $2`,
    [input.releaseId, connectionId],
  );

  if (revision.rows[0] === undefined) {
    await client.query(
      `INSERT INTO area_connection_revisions(
         id, content_release_id, connection_id, access_rule, active
       ) VALUES ($1, $2, $3, $4::jsonb, TRUE)`,
      [randomUUID(), input.releaseId, connectionId, JSON.stringify(input.accessRule)],
    );
  } else {
    await client.query(
      `UPDATE area_connection_revisions
       SET access_rule = $3::jsonb, active = TRUE
       WHERE content_release_id = $1 AND connection_id = $2`,
      [input.releaseId, connectionId, JSON.stringify(input.accessRule)],
    );
  }
}

export class PostgresZhouliaDraftStructureImporter {
  public constructor(private readonly pool: Pool) {}

  public async import(input: {
    readonly releaseId: string;
    readonly bundle?: ZhouliaContentBundle;
  }): Promise<ZhouliaDraftStructureImportResult> {
    const bundle = input.bundle ?? ZHOULIA_TYPED_CONTENT_V1;
    validateZhouliaContentBundle(bundle);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `catalog-release:${input.releaseId}`,
      ]);
      await requireDraftRelease(client, input.releaseId);
      const regionId = await resolveZhouliaRegion(client, input.releaseId);

      const areaIdsByIdentity: Record<string, string> = {};
      for (const [index, area] of bundle.areas.entries()) {
        const areaId = await ensureArea(client, {
          releaseId: input.releaseId,
          regionId,
          slug: zhouliaAreaSlug(area),
          displayName: area.displayName,
          data: zhouliaWorldAreaConfig(area, index),
        });
        areaIdsByIdentity[area.identity] = areaId;
      }

      const directedRoutes = buildZhouliaDirectedRoutes(bundle);
      for (const route of directedRoutes) {
        const fromAreaId = areaIdsByIdentity[route.fromAreaIdentity];
        const toAreaId = areaIdsByIdentity[route.toAreaIdentity];
        if (fromAreaId === undefined || toAreaId === undefined) {
          throw new Error(`Route ${route.identity} references an unresolved area`);
        }
        await ensureConnection(client, {
          releaseId: input.releaseId,
          fromAreaId,
          toAreaId,
          connectionKey: route.connectionKey,
          accessRule: route.accessRule,
        });
      }

      await client.query("COMMIT");

      const pending = buildZhouliaEncounterPoolDraftPlans(bundle).map((pool) => ({
        identity: pool.identity,
        areaIdentity: pool.areaIdentity,
        speciesKeys: pool.speciesKeys,
      }));

      return {
        releaseId: input.releaseId,
        regionId,
        bundleFingerprint: zhouliaContentFingerprint(bundle),
        areaIdsByIdentity,
        directedConnectionCount: directedRoutes.length,
        encounterPoolsPendingBalance: pending,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
