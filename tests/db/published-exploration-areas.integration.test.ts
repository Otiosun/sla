import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPublishedExplorationAreas } from "../../src/platform/exploration/postgres-published-exploration-areas.js";

const enabled =
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1" &&
  typeof process.env.POSTGRES_INTEGRATION_TEST_URL === "string";

const dbName = `pokemon_exp_coverage_${process.pid}_${Date.now()}`;

describe.skipIf(!enabled)("published exploration area coverage (isolated PostgreSQL)", () => {
  let admin: Pool;
  let pool: Pool;
  let provider: PostgresPublishedExplorationAreas;

  const releaseId = randomUUID();
  const rulesetId = randomUUID();
  const regionId = randomUUID();
  const villageId = randomUUID();
  const yunId = randomUUID();
  const otherId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();

  async function seed(): Promise<void> {
    const typeId = randomUUID();
    await pool.query(
      "INSERT INTO rulesets(id,key,version,engine_contract_version,config,status) VALUES ($1,$2,1,1,'{}'::jsonb,'DRAFT')",
      [rulesetId, `exp-coverage-${rulesetId}`],
    );
    await pool.query(
      "INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id) VALUES ($1,939001,'Exploration published fixture','DRAFT',$2)",
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO regions(id,slug) VALUES ($1,'zhoulia')", [regionId]);
    await pool.query(
      "INSERT INTO region_revisions(id,content_release_id,region_id,display_name,active) VALUES ($1,$2,$3,'Zhoulia',TRUE)",
      [randomUUID(), releaseId, regionId],
    );
    for (const [areaId, slug] of [
      [villageId, "vila-dos-arrozais"],
      [yunId, "campos-de-yun"],
      [otherId, "outra-area"],
    ]) {
      await pool.query("INSERT INTO areas(id,region_id,slug) VALUES ($1,$2,$3)", [
        areaId,
        regionId,
        slug,
      ]);
      await pool.query(
        "INSERT INTO area_revisions(id,content_release_id,area_id,display_name,active) VALUES ($1,$2,$3,$4,TRUE)",
        [randomUUID(), releaseId, areaId, slug],
      );
    }
    await pool.query("INSERT INTO pokemon_types(id,slug) VALUES ($1,'normal')", [typeId]);
    await pool.query(
      "INSERT INTO pokemon_species(id,national_dex,slug) VALUES ($1,987,'exp-test-species')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES ($1,$2,'default')", [
      formId,
      speciesId,
    ]);
    await pool.query(
      "INSERT INTO pokemon_species_revisions(id,content_release_id,species_id,display_name,active) VALUES ($1,$2,$3,'Test Species',TRUE)",
      [randomUUID(), releaseId, speciesId],
    );
    await pool.query(
      `INSERT INTO pokemon_form_revisions(
         id,content_release_id,form_id,display_name,type1_id,
         base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed,active
       ) VALUES ($1,$2,$3,'Test Form',$4,40,40,40,40,40,40,TRUE)`,
      [randomUUID(), releaseId, formId, typeId],
    );

    for (const [areaId, activeTable, activeEntry] of [
      [villageId, true, true],
      [yunId, false, true],
      [otherId, true, true],
    ] as const) {
      const tableId = randomUUID();
      const revisionId = randomUUID();
      await pool.query("INSERT INTO encounter_tables(id,area_id,slug) VALUES ($1,$2,$3)", [
        tableId,
        areaId,
        `pool-${areaId}`,
      ]);
      await pool.query(
        "INSERT INTO encounter_table_revisions(id,content_release_id,encounter_table_id,active) VALUES ($1,$2,$3,$4)",
        [revisionId, releaseId, tableId, activeTable],
      );
      await pool.query(
        "INSERT INTO encounter_entries(id,encounter_table_revision_id,form_id,weight,min_level,max_level,active) VALUES ($1,$2,$3,100,2,5,$4)",
        [randomUUID(), revisionId, formId, activeEntry],
      );
    }

    const emptyYunTable = randomUUID();
    await pool.query("INSERT INTO encounter_tables(id,area_id,slug) VALUES ($1,$2,'empty-yun')", [
      emptyYunTable,
      yunId,
    ]);
    await pool.query(
      "INSERT INTO encounter_table_revisions(id,content_release_id,encounter_table_id,active) VALUES ($1,$2,$3,TRUE)",
      [randomUUID(), releaseId, emptyYunTable],
    );
    await pool.query(
      "UPDATE rulesets SET status='VALIDATED',validated_at=now(),validation_report='{}'::jsonb,config_fingerprint=$2 WHERE id=$1",
      [rulesetId, "a".repeat(64)],
    );
    await pool.query("UPDATE rulesets SET status='PUBLISHED',published_at=now() WHERE id=$1", [
      rulesetId,
    ]);
    await pool.query(
      "UPDATE content_releases SET status='VALIDATED',validated_at=now(),validation_report='{}'::jsonb,content_fingerprint=$2 WHERE id=$1",
      [releaseId, "b".repeat(64)],
    );
    await pool.query(
      "UPDATE content_releases SET status='PUBLISHED',published_at=now() WHERE id=$1",
      [releaseId],
    );
    await pool.query(
      "INSERT INTO content_release_pointers(pointer_key,content_release_id) VALUES ('ACTIVE',$1)",
      [releaseId],
    );
  }

  beforeAll(async () => {
    const connection = process.env.POSTGRES_INTEGRATION_TEST_URL;
    if (connection === undefined) throw new Error("Disposable PostgreSQL URL missing");
    const adminUrl = new URL(connection);
    adminUrl.pathname = "/postgres";
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(connection);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString(), max: 2 });
    await runMigrations(pool, { appliedBy: "exploration-coverage-vitest" });
    await seed();
    provider = new PostgresPublishedExplorationAreas(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
  });

  it("returns only published areas with active tables AND entries, not inactive or draft content", async () => {
    expect(await provider.forActiveRelease(releaseId)).toEqual({
      contentReleaseId: releaseId,
      encounterReadyAreaIds: [villageId],
    });
  });

  it("never mixes a different content release with the ACTIVE release", async () => {
    expect(await provider.forActiveRelease(randomUUID())).toBeNull();
  });

  it("fails closed if the ACTIVE release pointer disappears", async () => {
    await pool.query("DELETE FROM content_release_pointers WHERE pointer_key='ACTIVE'");
    expect(await provider.forActiveRelease(releaseId)).toBeNull();
  });
});
