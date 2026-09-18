import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { ZHOULIA_TYPED_CONTENT_V1 } from "../../src/modules/world/zhoulia-content.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { PostgresZhouliaDraftStructureImporter } from "../../src/platform/world/postgres-zhoulia-draft-importer.js";
import { PostgresZhouliaEncounterDraftMaterializer } from "../../src/platform/world/postgres-zhoulia-encounter-materializer.js";

const enabled =
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1" &&
  typeof process.env.POSTGRES_INTEGRATION_TEST_URL === "string";

describe.skipIf(!enabled)("Zhoulia release lifecycle", () => {
  let admin: Client;
  let pool: Pool;
  let databaseName: string;

  beforeAll(async () => {
    const adminUrl = process.env.POSTGRES_INTEGRATION_TEST_URL;
    if (adminUrl === undefined) throw new Error("POSTGRES_INTEGRATION_TEST_URL missing");

    admin = new Client({ connectionString: adminUrl });
    await admin.connect();

    databaseName = `bell_zhoulia_v2l_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);

    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${databaseName}`;
    dbUrl.search = "";

    const migrated = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--import", "tsx", "src/platform/db/cli.ts", "migrate"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, DATABASE_URL: dbUrl.toString() },
      },
    );
    if ((migrated.status ?? 1) !== 0) {
      throw new Error(`db:migrate failed:\n${migrated.stdout}\n${migrated.stderr}`);
    }

    const seeded = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--import", "tsx", "db/seeds/phase4_vertical_slice.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, DATABASE_URL: dbUrl.toString() },
      },
    );
    if ((seeded.status ?? 1) !== 0) {
      throw new Error(`Phase 4 disposable seed failed:\n${seeded.stdout}\n${seeded.stderr}`);
    }

    pool = new Pool({ connectionString: dbUrl.toString() });
  }, 120_000);

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

  async function seedZhouliaSpeciesFixture(releaseId: string): Promise<void> {
    const type = await pool.query<{ id: string }>(
      `SELECT revision.type_id AS id
       FROM pokemon_type_revisions revision
       JOIN pokemon_types type ON type.id=revision.type_id
       WHERE revision.content_release_id=$1
         AND revision.active=TRUE
         AND type.slug='normal'
       LIMIT 1`,
      [releaseId],
    );
    const typeId = type.rows[0]?.id;
    if (typeId === undefined) throw new Error("Phase 4 clone has no active Normal type");

    const ability = await pool.query<{ id: string }>(
      `SELECT ability_id AS id
       FROM ability_revisions
       WHERE content_release_id=$1 AND active=TRUE
       ORDER BY display_name
       LIMIT 1`,
      [releaseId],
    );
    const abilityId = ability.rows[0]?.id;
    if (abilityId === undefined) throw new Error("Phase 4 clone has no active ability");

    const move = await pool.query<{ id: string }>(
      `SELECT move_id AS id
       FROM move_revisions
       WHERE content_release_id=$1 AND active=TRUE
       ORDER BY display_name
       LIMIT 1`,
      [releaseId],
    );
    const moveId = move.rows[0]?.id;
    if (moveId === undefined) throw new Error("Phase 4 clone has no active move");

    const speciesSlugs = [
      ...new Set(
        ZHOULIA_TYPED_CONTENT_V1.areas.flatMap((area) =>
          area.encounterPools.flatMap((table) =>
            table.entries.map((entry) => entry.speciesKey.replace("pokemon.species.", "")),
          ),
        ),
      ),
    ];

    for (const slug of speciesSlugs) {
      const existingSpecies = await pool.query<{ id: string }>(
        "SELECT id FROM pokemon_species WHERE slug=$1",
        [slug],
      );

      let speciesId = existingSpecies.rows[0]?.id;
      if (speciesId === undefined) {
        const nextDex = await pool.query<{ national_dex: number }>(
          "SELECT COALESCE(MAX(national_dex),0)::int + 1 AS national_dex FROM pokemon_species",
        );
        speciesId = randomUUID();
        await pool.query("INSERT INTO pokemon_species(id,national_dex,slug) VALUES ($1,$2,$3)", [
          speciesId,
          nextDex.rows[0]?.national_dex ?? 1,
          slug,
        ]);
      }

      const speciesRevision = await pool.query<{ id: string }>(
        `SELECT id
         FROM pokemon_species_revisions
         WHERE content_release_id=$1 AND species_id=$2`,
        [releaseId, speciesId],
      );
      if (speciesRevision.rows[0] === undefined) {
        await pool.query(
          `INSERT INTO pokemon_species_revisions(
             id,content_release_id,species_id,display_name,catch_rate,base_exp,active,data
           ) VALUES ($1,$2,$3,$4,100,50,TRUE,'{}'::jsonb)`,
          [randomUUID(), releaseId, speciesId, slug],
        );
      }

      const existingForm = await pool.query<{ id: string }>(
        "SELECT id FROM pokemon_forms WHERE species_id=$1 AND slug='default'",
        [speciesId],
      );
      const formId = existingForm.rows[0]?.id ?? randomUUID();
      if (existingForm.rows[0] === undefined) {
        await pool.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES ($1,$2,'default')", [
          formId,
          speciesId,
        ]);
      }

      const formRevision = await pool.query<{ id: string }>(
        `SELECT id
         FROM pokemon_form_revisions
         WHERE content_release_id=$1 AND form_id=$2`,
        [releaseId, formId],
      );
      if (formRevision.rows[0] === undefined) {
        await pool.query(
          `INSERT INTO pokemon_form_revisions(
             id,content_release_id,form_id,display_name,type1_id,type2_id,
             base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed,active,data
           ) VALUES ($1,$2,$3,$4,$5,NULL,40,40,40,40,40,40,TRUE,'{}'::jsonb)`,
          [randomUUID(), releaseId, formId, slug, typeId],
        );
      }

      await pool.query(
        `INSERT INTO pokemon_form_ability_options(
           id,content_release_id,form_id,ability_id,slot_kind
         ) VALUES ($1,$2,$3,$4,'PRIMARY')
         ON CONFLICT (content_release_id,form_id,ability_id,slot_kind)
         DO NOTHING`,
        [randomUUID(), releaseId, formId, abilityId],
      );

      const existingLearnset = await pool.query<{ id: string }>(
        `SELECT id
         FROM move_learnset_entries
         WHERE content_release_id=$1
           AND form_id=$2
           AND move_id=$3
           AND learn_method='START'
           AND learn_level IS NULL
         LIMIT 1`,
        [releaseId, formId, moveId],
      );
      if (existingLearnset.rows[0] === undefined) {
        await pool.query(
          `INSERT INTO move_learnset_entries(
             id,content_release_id,form_id,move_id,learn_method,learn_level
           ) VALUES ($1,$2,$3,$4,'START',NULL)`,
          [randomUUID(), releaseId, formId, moveId],
        );
      }
    }
  }

  it("clones ACTIVE content, imports Zhoulia, validates, publishes, activates, rolls back and reactivates", async () => {
    const parentResult = await pool.query<{
      id: string;
      release_no: string;
      status: string;
      ruleset_status: string;
    }>(
      `SELECT release.id,
                release.release_no::text,
                release.status,
                ruleset.status AS ruleset_status
         FROM content_release_pointers pointer
         JOIN content_releases release ON release.id=pointer.content_release_id
         JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
         WHERE pointer.pointer_key='ACTIVE'`,
    );
    const parent = parentResult.rows[0];
    if (parent === undefined) throw new Error("Phase 4 seed did not create ACTIVE content");

    expect(parent.status).toBe("PUBLISHED");
    expect(parent.ruleset_status).toBe("PUBLISHED");

    const releaseId = randomUUID();
    const nextRelease = await pool.query<{ release_no: string }>(
      "SELECT (MAX(release_no) + 1)::text AS release_no FROM content_releases",
    );
    const releaseNo = nextRelease.rows[0]?.release_no;
    if (releaseNo === undefined) throw new Error("Could not allocate release number");

    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    const cloned = await catalog.clonePublishedRelease({
      parentReleaseId: parent.id,
      newReleaseId: releaseId,
      releaseNo: BigInt(releaseNo),
      name: "Bell Zhoulia V2L Disposable Candidate",
    });
    expect(cloned.ok).toBe(true);
    if (!cloned.ok) throw new Error(`clone failed: ${cloned.error.code}`);

    await seedZhouliaSpeciesFixture(releaseId);

    const structure = await new PostgresZhouliaDraftStructureImporter(pool).import({
      releaseId,
    });
    expect(Object.keys(structure.areaIdsByIdentity)).toHaveLength(2);
    expect(structure.directedConnectionCount).toBe(2);

    const encounters = await new PostgresZhouliaEncounterDraftMaterializer(pool).materialize({
      releaseId,
    });
    expect(encounters.tablesMaterialized).toBe(7);
    expect(encounters.entriesMaterialized).toBeGreaterThan(0);

    const beforeValidation = await pool.query<{
      status: string;
      active_release_id: string;
    }>(
      `SELECT release.status,
                (SELECT content_release_id
                   FROM content_release_pointers
                  WHERE pointer_key='ACTIVE') AS active_release_id
         FROM content_releases release
         WHERE release.id=$1`,
      [releaseId],
    );
    expect(beforeValidation.rows[0]?.status).toBe("DRAFT");
    expect(beforeValidation.rows[0]?.active_release_id).toBe(parent.id);

    const validated = await catalog.validateRelease(releaseId);
    if (!validated.ok) {
      throw new Error(
        `validate failed [${validated.error.code}]: ${validated.error.message} ${JSON.stringify(
          validated.error.details ?? {},
        )}`,
      );
    }
    expect(validated.value.report.valid).toBe(true);
    expect(validated.value.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const afterValidation = await pool.query<{
      status: string;
      fingerprint: string | null;
      active_release_id: string;
    }>(
      `SELECT release.status,
                release.content_fingerprint AS fingerprint,
                (SELECT content_release_id
                   FROM content_release_pointers
                  WHERE pointer_key='ACTIVE') AS active_release_id
         FROM content_releases release
         WHERE release.id=$1`,
      [releaseId],
    );
    expect(afterValidation.rows[0]?.status).toBe("VALIDATED");
    expect(afterValidation.rows[0]?.fingerprint).toBe(validated.value.fingerprint);
    expect(afterValidation.rows[0]?.active_release_id).toBe(parent.id);

    const published = await catalog.publishRelease(releaseId);
    if (!published.ok) {
      throw new Error(`publish failed [${published.error.code}]: ${published.error.message}`);
    }

    const afterPublish = await pool.query<{
      status: string;
      active_release_id: string;
    }>(
      `SELECT release.status,
                (SELECT content_release_id
                   FROM content_release_pointers
                  WHERE pointer_key='ACTIVE') AS active_release_id
         FROM content_releases release
         WHERE release.id=$1`,
      [releaseId],
    );
    expect(afterPublish.rows[0]?.status).toBe("PUBLISHED");
    expect(afterPublish.rows[0]?.active_release_id).toBe(parent.id);

    const activated = await catalog.activateRelease(releaseId);
    if (!activated.ok) {
      throw new Error(`activation failed [${activated.error.code}]: ${activated.error.message}`);
    }

    const final = await pool.query<{
      active_release_id: string;
      parent_status: string;
      candidate_status: string;
      zhoulia_regions: number;
      zhoulia_areas: number;
      zhoulia_tables: number;
    }>(
      `SELECT
           (SELECT content_release_id
              FROM content_release_pointers
             WHERE pointer_key='ACTIVE') AS active_release_id,
           (SELECT status FROM content_releases WHERE id=$1) AS parent_status,
           (SELECT status FROM content_releases WHERE id=$2) AS candidate_status,
           (SELECT count(*)::int
              FROM region_revisions revision
              JOIN regions region ON region.id=revision.region_id
             WHERE revision.content_release_id=$2
               AND revision.active=TRUE
               AND region.slug='zhoulia') AS zhoulia_regions,
           (SELECT count(*)::int
              FROM area_revisions revision
              JOIN areas area ON area.id=revision.area_id
              JOIN regions region ON region.id=area.region_id
             WHERE revision.content_release_id=$2
               AND revision.active=TRUE
               AND region.slug='zhoulia'
               AND area.slug IN ('vila-dos-arrozais','campos-de-yun')) AS zhoulia_areas,
           (SELECT count(*)::int
              FROM encounter_table_revisions revision
              JOIN encounter_tables encounter_table
                ON encounter_table.id=revision.encounter_table_id
              JOIN areas area ON area.id=encounter_table.area_id
              JOIN regions region ON region.id=area.region_id
             WHERE revision.content_release_id=$2
               AND revision.active=TRUE
               AND region.slug='zhoulia') AS zhoulia_tables`,
      [parent.id, releaseId],
    );

    expect(final.rows[0]).toMatchObject({
      active_release_id: releaseId,
      parent_status: "PUBLISHED",
      candidate_status: "PUBLISHED",
      zhoulia_regions: 1,
      zhoulia_areas: 2,
      zhoulia_tables: 7,
    });

    const rollback = await catalog.rollbackActiveRelease(parent.id);
    if (!rollback.ok) {
      throw new Error(`rollback failed [${rollback.error.code}]: ${rollback.error.message}`);
    }
    expect(rollback.value.fromReleaseId).toBe(releaseId);
    expect(rollback.value.toReleaseId).toBe(parent.id);

    const reactivated = await catalog.activateRelease(releaseId);
    if (!reactivated.ok) {
      throw new Error(
        `reactivation failed [${reactivated.error.code}]: ${reactivated.error.message}`,
      );
    }

    const pointer = await pool.query<{ content_release_id: string }>(
      "SELECT content_release_id FROM content_release_pointers WHERE pointer_key='ACTIVE'",
    );
    expect(pointer.rows[0]?.content_release_id).toBe(releaseId);
  }, 120_000);
});
