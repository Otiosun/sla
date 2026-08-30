import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Gen123WorldEdge } from "../../db/imports/gen123/world-source.js";
import * as worldModule from "../../db/imports/gen123/world.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

type ReconcileGen123WorldConnections = (
  client: PoolClient,
  releaseId: string,
  idBySlug: ReadonlyMap<string, string>,
  edges: readonly Gen123WorldEdge[],
) => Promise<void>;

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function runtimeDatabaseUrl(name: string, role: string, password: string): string {
  const url = new URL(databaseUrlFor(name));
  url.username = role;
  url.password = password;
  return url.toString();
}

describe.sequential("Gen I-III world reconciliation with runtime privileges", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const dbName = `pokemon_gen123_world_${suffix}`;
  const runtimeRole = `world_runtime_${suffix}`;
  const runtimePassword = "world-runtime-test-password";
  const releaseId = randomUUID();
  let adminPool: Pool;
  let pool: Pool;
  let runtimePool: Pool;
  let idBySlug: ReadonlyMap<string, string>;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "phase17-world-runtime-vitest" });

    const rulesetId = randomUUID();
    const regionId = randomUUID();
    const areas = new Map([
      ["pallet-town", randomUUID()],
      ["route-1", randomUUID()],
      ["viridian-city", randomUUID()],
    ] as const);

    await pool.query(
      `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
       VALUES ($1, 'phase17-world-runtime', 1, 1, '{}'::jsonb, 'DRAFT')`,
      [rulesetId],
    );
    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
       VALUES ($1, 17001, 'Phase 17 world runtime reconciliation', 'DRAFT', $2)`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO regions(id, slug) VALUES ($1, 'kanto')", [regionId]);
    for (const [slug, areaId] of areas) {
      await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
        areaId,
        regionId,
        slug,
      ]);
    }
    idBySlug = areas;

    await adminPool.query(
      `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    await pool.query(
      `GRANT SELECT ON content_releases, areas, area_connections, area_connection_revisions TO "${runtimeRole}"`,
    );
    await pool.query(
      `GRANT INSERT, UPDATE ON area_connections, area_connection_revisions TO "${runtimeRole}"`,
    );

    runtimePool = new Pool({
      connectionString: runtimeDatabaseUrl(dbName, runtimeRole, runtimePassword),
      max: 2,
    });
  }, 30_000);

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    if (adminPool !== undefined) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminPool.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await adminPool.end();
    }
  }, 30_000);

  it("reconciles a changed topology and exact replay without DELETE privilege", async () => {
    const reconcile = (
      worldModule as unknown as {
        reconcileGen123WorldConnections?: ReconcileGen123WorldConnections;
      }
    ).reconcileGen123WorldConnections;

    expect(reconcile).toBeTypeOf("function");
    if (reconcile === undefined) return;

    const runtimeClient = await runtimePool.connect();
    try {
      const deletePrivilege = await runtimeClient.query<{ allowed: boolean }>(
        "SELECT has_table_privilege(current_user, 'public.area_connection_revisions', 'DELETE') AS allowed",
      );
      expect(deletePrivilege.rows[0]?.allowed).toBe(false);

      const initialTopology: readonly Gen123WorldEdge[] = [
        {
          fromSlug: "pallet-town",
          toSlug: "route-1",
          connectionKey: "north",
          source: "firered",
        },
        {
          fromSlug: "route-1",
          toSlug: "pallet-town",
          connectionKey: "south",
          source: "firered",
        },
        {
          fromSlug: "route-1",
          toSlug: "viridian-city",
          connectionKey: "north",
          source: "firered",
        },
      ];
      await reconcile(runtimeClient, releaseId, idBySlug, initialTopology);

      const changedTopology: readonly Gen123WorldEdge[] = [
        initialTopology[0]!,
        initialTopology[1]!,
        {
          fromSlug: "viridian-city",
          toSlug: "route-1",
          connectionKey: "south",
          source: "firered",
        },
      ];
      await reconcile(runtimeClient, releaseId, idBySlug, changedTopology);
      await reconcile(runtimeClient, releaseId, idBySlug, changedTopology);
    } finally {
      runtimeClient.release();
    }

    const revisions = await pool.query<{
      from_slug: string;
      to_slug: string;
      connection_key: string;
      active: boolean;
    }>(
      `SELECT source.slug AS from_slug,
              destination.slug AS to_slug,
              identity.connection_key,
              revision.active
         FROM area_connection_revisions revision
         JOIN area_connections identity ON identity.id = revision.connection_id
         JOIN areas source ON source.id = identity.from_area_id
         JOIN areas destination ON destination.id = identity.to_area_id
        WHERE revision.content_release_id = $1
        ORDER BY source.slug, destination.slug, identity.connection_key`,
      [releaseId],
    );

    expect(revisions.rows).toEqual([
      {
        from_slug: "pallet-town",
        to_slug: "route-1",
        connection_key: "north",
        active: true,
      },
      {
        from_slug: "route-1",
        to_slug: "pallet-town",
        connection_key: "south",
        active: true,
      },
      {
        from_slug: "route-1",
        to_slug: "viridian-city",
        connection_key: "north",
        active: false,
      },
      {
        from_slug: "viridian-city",
        to_slug: "route-1",
        connection_key: "south",
        active: true,
      },
    ]);
  });
});
