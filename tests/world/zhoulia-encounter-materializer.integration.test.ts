import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZHOULIA_TYPED_CONTENT_V1 } from "../../src/modules/world/zhoulia-content.js";
import { choosePublishedSearchOutcome } from "../../src/platform/exploration/expedition-published-outcome-policy.js";
import { choosePublishedResource } from "../../src/platform/exploration/postgres-expedition-v4-resources.js";
import { PostgresZhouliaDraftStructureImporter } from "../../src/platform/world/postgres-zhoulia-draft-importer.js";
import { PostgresZhouliaEncounterDraftMaterializer } from "../../src/platform/world/postgres-zhoulia-encounter-materializer.js";

const enabled =
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1" &&
  typeof process.env.POSTGRES_INTEGRATION_TEST_URL === "string";

describe.skipIf(!enabled)("Zhoulia encounter DRAFT materializer", () => {
  let admin: Client;
  let pool: Pool;
  let databaseName: string;

  beforeAll(async () => {
    const adminUrl = process.env.POSTGRES_INTEGRATION_TEST_URL;
    if (adminUrl === undefined) throw new Error("POSTGRES_INTEGRATION_TEST_URL missing");

    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    databaseName = `bell_zhoulia_v2e_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);

    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${databaseName}`;
    dbUrl.search = "";

    const migrated = spawnSync("pnpm", ["db:migrate"], {
      cwd: process.cwd(),
      shell: true,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: dbUrl.toString(),
        MIGRATOR_DATABASE_URL: dbUrl.toString(),
      },
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

  async function seedDraft(): Promise<string> {
    const rulesetId = randomUUID();
    const releaseId = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(id,key,version,engine_contract_version,config,status)
       VALUES ($1,$2,1,1,$3::jsonb,'DRAFT')`,
      [
        rulesetId,
        `zhoulia-v2e-${rulesetId}`,
        JSON.stringify({
          schemaVersion: 1,
          capture: {
            model: "POKEMON_INSPIRED_V1",
            maxProbabilityBasisPoints: 10000,
          },
        }),
      ],
    );

    const releaseNo = await pool.query<{ release_no: string }>(
      "SELECT (COALESCE(MAX(release_no), 910000) + 1)::text AS release_no FROM content_releases",
    );
    await pool.query(
      `INSERT INTO content_releases(
         id,release_no,name,status,parent_release_id,default_ruleset_id
       ) VALUES ($1,$3::bigint,'Zhoulia V2E Test','DRAFT',NULL,$2)`,
      [releaseId, rulesetId, releaseNo.rows[0]?.release_no ?? "910001"],
    );

    const requestedRegionId = randomUUID();
    const region = await pool.query<{ id: string }>(
      `INSERT INTO regions(id,slug)
       VALUES ($1,'zhoulia')
       ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug
       RETURNING id`,
      [requestedRegionId],
    );
    const regionId = region.rows[0]?.id;
    if (regionId === undefined) throw new Error("Zhoulia region seed failed");

    await pool.query(
      `INSERT INTO region_revisions(
         id,content_release_id,region_id,display_name,active,data
       ) VALUES ($1,$2,$3,'Zhoulia',TRUE,'{}'::jsonb)`,
      [randomUUID(), releaseId, regionId],
    );

    const requestedTypeId = randomUUID();
    const type = await pool.query<{ id: string }>(
      `INSERT INTO pokemon_types(id,slug)
       VALUES ($1,'normal')
       ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug
       RETURNING id`,
      [requestedTypeId],
    );
    const typeId = type.rows[0]?.id;
    if (typeId === undefined) throw new Error("Normal type seed failed");

    await pool.query(
      `INSERT INTO pokemon_type_revisions(
         id,content_release_id,type_id,display_name,active,data
       ) VALUES ($1,$2,$3,'Normal',TRUE,'{}'::jsonb)`,
      [randomUUID(), releaseId, typeId],
    );

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

      await pool.query(
        `INSERT INTO pokemon_species_revisions(
           id,content_release_id,species_id,display_name,catch_rate,base_exp,active,data
         ) VALUES ($1,$2,$3,$4,100,50,TRUE,'{}'::jsonb)`,
        [randomUUID(), releaseId, speciesId, slug],
      );

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

      await pool.query(
        `INSERT INTO pokemon_form_revisions(
           id,content_release_id,form_id,display_name,type1_id,type2_id,
           base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed,active,data
         ) VALUES ($1,$2,$3,$4,$5,NULL,40,40,40,40,40,40,TRUE,'{}'::jsonb)`,
        [randomUUID(), releaseId, formId, slug, typeId],
      );
    }

    return releaseId;
  }

  it("materializes seven versioned encounter tables and replays idempotently", async () => {
    const releaseId = await seedDraft();
    const structure = new PostgresZhouliaDraftStructureImporter(pool);
    await structure.import({ releaseId });

    const materializer = new PostgresZhouliaEncounterDraftMaterializer(pool);
    const first = await materializer.materialize({ releaseId });

    expect(first.tablesMaterialized).toBe(7);
    expect(first.entriesMaterialized).toBe(
      ZHOULIA_TYPED_CONTENT_V1.areas.reduce(
        (sum, area) =>
          sum + area.encounterPools.reduce((areaSum, table) => areaSum + table.entries.length, 0),
        0,
      ),
    );

    const tables = await pool.query<{
      area_slug: string;
      table_slug: string;
      conditions: {
        timeOfDay?: string;
        surface?: string;
        rarity?: string;
      };
    }>(
      `SELECT area.slug AS area_slug,
              encounter_table.slug AS table_slug,
              revision.conditions
       FROM encounter_tables AS encounter_table
       JOIN areas AS area ON area.id=encounter_table.area_id
       JOIN encounter_table_revisions AS revision
         ON revision.encounter_table_id=encounter_table.id
       WHERE revision.content_release_id=$1
       ORDER BY area.slug, encounter_table.slug`,
      [releaseId],
    );

    expect(tables.rowCount).toBe(7);
    expect(
      tables.rows
        .filter((row) => row.area_slug === "vila-dos-arrozais")
        .map((row) => row.table_slug),
    ).toEqual(["day-land", "night-land", "village-rare", "water"]);
    expect(
      tables.rows.filter((row) => row.area_slug === "campos-de-yun").map((row) => row.table_slug),
    ).toEqual(["day-land", "night-land", "rivers"]);

    expect(
      tables.rows.some(
        (row) =>
          row.area_slug === "vila-dos-arrozais" &&
          row.conditions.timeOfDay === "NIGHT" &&
          row.conditions.surface === "LAND",
      ),
    ).toBe(true);

    expect(
      tables.rows.some(
        (row) => row.area_slug === "vila-dos-arrozais" && row.conditions.rarity === "RARE",
      ),
    ).toBe(true);

    const vilaEntries = await pool.query<{
      min_level: number;
      max_level: number;
      weight: string;
    }>(
      `SELECT entry.min_level,entry.max_level,entry.weight::text
       FROM encounter_entries AS entry
       JOIN encounter_table_revisions AS revision
         ON revision.id=entry.encounter_table_revision_id
       JOIN encounter_tables AS encounter_table
         ON encounter_table.id=revision.encounter_table_id
       JOIN areas AS area ON area.id=encounter_table.area_id
       WHERE revision.content_release_id=$1
         AND area.slug='vila-dos-arrozais'`,
      [releaseId],
    );

    expect(
      vilaEntries.rows.every(
        (row) => row.min_level === 2 && row.max_level === 5 && row.weight === "100",
      ),
    ).toBe(true);

    const yunEntries = await pool.query<{
      min_level: number;
      max_level: number;
      weight: string;
    }>(
      `SELECT entry.min_level,entry.max_level,entry.weight::text
       FROM encounter_entries AS entry
       JOIN encounter_table_revisions AS revision
         ON revision.id=entry.encounter_table_revision_id
       JOIN encounter_tables AS encounter_table
         ON encounter_table.id=revision.encounter_table_id
       JOIN areas AS area ON area.id=encounter_table.area_id
       WHERE revision.content_release_id=$1
         AND area.slug='campos-de-yun'`,
      [releaseId],
    );

    expect(
      yunEntries.rows.every(
        (row) => row.min_level === 4 && row.max_level === 8 && row.weight === "100",
      ),
    ).toBe(true);

    const before = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM encounter_entries",
    );
    await materializer.materialize({ releaseId });
    const after = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM encounter_entries",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("refuses materialization after the release leaves DRAFT", async () => {
    const releaseId = await seedDraft();
    const structure = new PostgresZhouliaDraftStructureImporter(pool);
    await structure.import({ releaseId });

    await pool.query(
      `UPDATE content_releases
       SET status='VALIDATED',
           validated_at=now(),
           validation_report='{"valid":true,"issues":[]}'::jsonb,
           content_fingerprint=$2
       WHERE id=$1`,
      [releaseId, "1".repeat(64)],
    );

    const materializer = new PostgresZhouliaEncounterDraftMaterializer(pool);
    await expect(materializer.materialize({ releaseId })).rejects.toThrow(/DRAFT/);
  });
  it("materializes the approved isolated V4 release content and exact outcome distributions", async () => {
    const releaseId = await seedDraft();
    await pool.query(await readFile("db/candidates/0080_solo_exploration_v4.sql", "utf8"));
    await pool.query(await readFile("db/candidates/0083_expedition_reports.sql", "utf8"));
    const imported = await new PostgresZhouliaDraftStructureImporter(pool).import({ releaseId });
    const materializer = new PostgresZhouliaEncounterDraftMaterializer(pool);
    await materializer.materialize({ releaseId });
    await pool.query(
      "INSERT INTO currency_definitions(id,slug,display_name) VALUES($1,'pokedollar','Pokédollar')",
      [randomUUID()],
    );
    for (const [slug, kind] of [
      ["poke-ball", "BALL"],
      ["potion", "MEDICINE"],
    ] as const) {
      const item = randomUUID();
      await pool.query("INSERT INTO items(id,slug) VALUES($1,$2)", [item, slug]);
      await pool.query(
        "INSERT INTO item_revisions(id,content_release_id,item_id,display_name,item_kind) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), releaseId, item, slug, kind],
      );
    }
    await expect(
      materializer.materializeApprovedV4({ releaseId, reservedSpeciesSlugs: ["gastly"] }),
    ).rejects.toThrow("reserved species");
    const input = { releaseId, reservedSpeciesSlugs: [] };
    expect(await materializer.materializeApprovedV4(input)).toMatchObject({
      tablesMaterialized: 6,
      entriesMaterialized: 39,
    });
    expect(await materializer.materializeApprovedV4(input)).toMatchObject({
      tablesMaterialized: 6,
      entriesMaterialized: 39,
    });
    const pools = await pool.query(
      `SELECT area.slug AS area, pool.slug, array_agg(species.slug ORDER BY species.slug) AS species,
         min(entry.weight)::int AS weight, min(entry.min_level) AS lo, max(entry.max_level) AS hi
       FROM encounter_table_revisions revision JOIN encounter_tables pool ON pool.id=revision.encounter_table_id
       JOIN areas area ON area.id=pool.area_id JOIN encounter_entries entry ON entry.encounter_table_revision_id=revision.id
       JOIN pokemon_forms form ON form.id=entry.form_id JOIN pokemon_species species ON species.id=form.species_id
       WHERE revision.content_release_id=$1 AND revision.active AND entry.active
       GROUP BY area.slug,pool.slug ORDER BY area.slug,pool.slug`,
      [releaseId],
    );
    expect(pools.rows).toHaveLength(6);
    expect(
      pools.rows.find((row) => row.area === "campos-de-yun" && row.slug === "night-land"),
    ).toEqual({
      area: "campos-de-yun",
      slug: "night-land",
      species: ["gastly", "hoothoot", "poochyena", "rattata", "roselia", "shuppet", "zubat"],
      weight: 100,
      lo: 4,
      hi: 8,
    });
    expect(
      (
        await pool.query(
          "SELECT access_rule->>'explorationMinutes' AS minutes FROM area_connection_revisions WHERE content_release_id=$1 AND active",
          [releaseId],
        )
      ).rows,
    ).toEqual([{ minutes: "30" }, { minutes: "30" }]);
    const search = (
      await pool.query(
        "SELECT weights FROM solo_search_outcome_policies WHERE content_release_id=$1",
        [releaseId],
      )
    ).rows;
    const loot = (
      await pool.query(
        "SELECT entries FROM solo_resource_loot_policies WHERE content_release_id=$1",
        [releaseId],
      )
    ).rows;
    expect(search).toHaveLength(4);
    expect(loot).toHaveLength(4);
    expect(imported.directedConnectionCount).toBe(2);
    expect(new Set(search.map((row) => JSON.stringify(row.weights))).size).toBe(1);
    expect(new Set(loot.map((row) => JSON.stringify(row.entries))).size).toBe(1);
    const searchCounts: Record<string, number> = {};
    const lootCounts: Record<string, number> = {};
    for (let roll = 0; roll < 10000; roll++) {
      const outcome = choosePublishedSearchOutcome(search[0].weights, roll);
      const resource = choosePublishedResource(loot[0].entries, roll);
      if (!outcome.ok || !resource.ok) throw new Error("Invalid approved distribution");
      const key =
        resource.value.kind === "NONE"
          ? "NONE"
          : resource.value.itemId + ":" + resource.value.quantity;
      searchCounts[outcome.value.kind] = (searchCounts[outcome.value.kind] ?? 0) + 1;
      lootCounts[key] = (lootCounts[key] ?? 0) + 1;
    }
    expect(searchCounts).toEqual({ NO_SIGNAL: 5000, TRAIL: 2500, INCIDENTAL: 1500, DIRECT: 1000 });
    expect(Object.values(lootCounts)).toEqual([7500, 1500, 700, 200, 100]);
    const reward = (
      await pool.query(
        "SELECT config FROM solo_report_reward_policies WHERE content_release_id=$1",
        [releaseId],
      )
    ).rows[0].config;
    expect(reward.base).toEqual([{ kind: "MONEY", currencyId: expect.any(String), amount: "300" }]);
    expect(reward.normal.map((entry: { weight: number }) => entry.weight)).toEqual([
      4500, 3000, 1500, 1000,
    ]);
    expect(reward.highlight.map((entry: { weight: number }) => entry.weight)).toEqual([
      6000, 2500, 1000, 500,
    ]);
    expect(
      (await pool.query("SELECT status FROM content_releases WHERE id=$1", [releaseId])).rows,
    ).toEqual([{ status: "DRAFT" }]);
  });
});
