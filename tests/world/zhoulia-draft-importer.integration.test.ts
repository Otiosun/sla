import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresZhouliaDraftStructureImporter } from "../../src/platform/world/postgres-zhoulia-draft-importer.js";

const enabled =
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1" &&
  typeof process.env.POSTGRES_INTEGRATION_TEST_URL === "string";

describe.skipIf(!enabled)("Zhoulia DRAFT structure importer", () => {
  let admin: Client;
  let pool: Pool;
  let databaseName: string;

  beforeAll(async () => {
    const adminUrl = process.env.POSTGRES_INTEGRATION_TEST_URL;
    if (adminUrl === undefined) throw new Error("POSTGRES_INTEGRATION_TEST_URL missing");

    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    databaseName = `bell_zhoulia_v2a_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);

    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${databaseName}`;
    dbUrl.search = "";

    const { spawnSync } = await import("node:child_process");
    const migrated = spawnSync("pnpm", ["db:migrate"], {
      cwd: process.cwd(),
      shell: true,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: dbUrl.toString() },
    });
    if ((migrated.status ?? 1) !== 0) {
      throw new Error(`db:migrate failed: ${migrated.stdout}\n${migrated.stderr}`);
    }

    pool = new Pool({ connectionString: dbUrl.toString() });
  });

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
    if (admin !== undefined) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });

  async function seedDraft() {
    const rulesetId = randomUUID();
    const releaseId = randomUUID();
    const regionId = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(id,key,version,engine_contract_version,config,status)
       VALUES ($1,$3,1,1,$2::jsonb,'DRAFT')`,
      [
        rulesetId,
        JSON.stringify({
          schemaVersion: 1,
          capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 10000 },
        }),
        `zhoulia-v2a-test-${rulesetId}`,
      ],
    );
    const releaseNo = await pool.query<{ release_no: string }>(
      "SELECT (COALESCE(MAX(release_no), 900000) + 1)::text AS release_no FROM content_releases",
    );
    await pool.query(
      `INSERT INTO content_releases(
         id,release_no,name,status,parent_release_id,default_ruleset_id
       ) VALUES ($1,$3::bigint,'Zhoulia V2A Test','DRAFT',NULL,$2)`,
      [releaseId, rulesetId, releaseNo.rows[0]?.release_no ?? "900001"],
    );
    const region = await pool.query<{ id: string }>(
      `INSERT INTO regions(id,slug)
       VALUES ($1,'zhoulia')
       ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug
       RETURNING id`,
      [regionId],
    );
    const resolvedRegionId = region.rows[0]?.id;
    if (resolvedRegionId === undefined) throw new Error("Zhoulia region seed failed");
    await pool.query(
      `INSERT INTO region_revisions(
         id,content_release_id,region_id,display_name,active,data
       ) VALUES ($1,$2,$3,'Zhoulia',TRUE,'{}'::jsonb)`,
      [randomUUID(), releaseId, resolvedRegionId],
    );
    return { releaseId, regionId: resolvedRegionId };
  }

  it("imports areas and bidirectional connections only into DRAFT and is idempotent", async () => {
    const seeded = await seedDraft();
    const importer = new PostgresZhouliaDraftStructureImporter(pool);

    const first = await importer.import({ releaseId: seeded.releaseId });
    expect(first.regionId).toBe(seeded.regionId);
    expect(first.directedConnectionCount).toBe(2);
    expect(first.encounterPoolsPendingBalance).toHaveLength(7);
    expect(Object.keys(first.areaIdsByIdentity)).toEqual([
      "zhoulia.area.vila-dos-arrozais",
      "zhoulia.area.campos-de-yun",
    ]);

    const areas = await pool.query<{
      slug: string;
      display_name: string;
      data: unknown;
    }>(
      `SELECT area.slug, revision.display_name, revision.data
       FROM areas AS area
       JOIN area_revisions AS revision ON revision.area_id=area.id
       WHERE revision.content_release_id=$1
       ORDER BY area.slug`,
      [seeded.releaseId],
    );
    expect(areas.rows.map((row) => [row.slug, row.display_name])).toEqual([
      ["campos-de-yun", "Campos de Yun"],
      ["vila-dos-arrozais", "Vila dos Arrozais"],
    ]);
    expect(areas.rows.find((row) => row.slug === "vila-dos-arrozais")?.data).toMatchObject({
      schemaVersion: 1,
      startingArea: true,
      presentation: {
        npcRoles: expect.arrayContaining([
          expect.objectContaining({ displayName: "Hana" }),
          expect.objectContaining({ roleKey: "SHAMAN", displayName: null }),
        ]),
      },
    });

    const connections = await pool.query(
      `SELECT connection.connection_key
       FROM area_connections AS connection
       JOIN area_connection_revisions AS revision
         ON revision.connection_id=connection.id
       WHERE revision.content_release_id=$1
       ORDER BY connection.connection_key`,
      [seeded.releaseId],
    );
    expect(connections.rows.map((row) => row.connection_key)).toEqual([
      "campos-de-yun-to-vila-dos-arrozais",
      "vila-dos-arrozais-to-campos-de-yun",
    ]);

    expect(
      await pool.query("SELECT 1 FROM content_release_pointers WHERE pointer_key='ACTIVE'"),
    ).toHaveProperty("rowCount", 0);

    await importer.import({ releaseId: seeded.releaseId });
    expect(
      await pool.query(
        `SELECT count(*)::int AS count
         FROM area_revisions WHERE content_release_id=$1`,
        [seeded.releaseId],
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
    expect(
      await pool.query(
        `SELECT count(*)::int AS count
         FROM area_connection_revisions WHERE content_release_id=$1`,
        [seeded.releaseId],
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
  });

  it("refuses to mutate a release after it leaves DRAFT", async () => {
    const seeded = await seedDraft();
    await pool.query(
      `UPDATE content_releases
       SET status='VALIDATED',
           validated_at=now(),
           validation_report='{"valid":true,"issues":[]}'::jsonb,
           content_fingerprint=$2
       WHERE id=$1`,
      [seeded.releaseId, "0".repeat(64)],
    );

    const importer = new PostgresZhouliaDraftStructureImporter(pool);
    await expect(importer.import({ releaseId: seeded.releaseId })).rejects.toThrow(/DRAFT/);
  });
});
