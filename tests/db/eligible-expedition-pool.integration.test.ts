import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareExpeditionEncounterWeights } from "../../src/modules/exploration/expedition-encounter-weighting.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEligibleExpeditionPoolReader } from "../../src/platform/exploration/postgres-eligible-expedition-pool.js";

const enabled =
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1" &&
  typeof process.env.POSTGRES_INTEGRATION_TEST_URL === "string";
const dbName = `pokemon_exp_eligible_${process.pid}_${Date.now()}`;

describe.skipIf(!enabled)("V1.2 published encounter eligibility", () => {
  let admin: Pool;
  let pool: Pool;
  let reader: PostgresEligibleExpeditionPoolReader;

  const releaseId = randomUUID();
  const rulesetId = randomUUID();
  const regionId = randomUUID();
  const villageId = randomUUID();
  const yunId = randomUUID();
  const playerId = randomUUID();
  const otherPlayerId = randomUUID();
  const knownSpeciesId = randomUUID();
  const unknownSpeciesId = randomUUID();
  const knownFormId = randomUUID();
  const unknownFormId = randomUUID();
  const tableId = randomUUID();
  const revisionId = randomUUID();
  const entries = {
    known: randomUUID(),
    unknown: randomUUID(),
    locked: randomUUID(),
    night: randomUUID(),
    water: randomUUID(),
  };

  const dayLand = {
    timeOfDay: "DAY" as const,
    surface: "LAND" as const,
  };
  const conditions = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      requiredUnlockKeys: [],
      blockedUnlockKeys: [],
      ...extra,
    });

  async function seed() {
    const typeId = randomUUID();
    await pool.query(
      "INSERT INTO rulesets(id,key,version,engine_contract_version,config,status) VALUES ($1,$2,1,1,'{}'::jsonb,'DRAFT')",
      [rulesetId, `exp-eligible-${rulesetId}`],
    );
    await pool.query(
      "INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id) VALUES ($1,939002,'V1.2 eligibility fixture','DRAFT',$2)",
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO regions(id,slug) VALUES ($1,'zhoulia')", [regionId]);
    await pool.query(
      "INSERT INTO region_revisions(id,content_release_id,region_id,display_name,active) VALUES ($1,$2,$3,'Zhoulia',TRUE)",
      [randomUUID(), releaseId, regionId],
    );
    for (const [id, slug] of [
      [villageId, "vila-dos-arrozais"],
      [yunId, "campos-de-yun"],
    ]) {
      await pool.query("INSERT INTO areas(id,region_id,slug) VALUES ($1,$2,$3)", [
        id,
        regionId,
        slug,
      ]);
      await pool.query(
        "INSERT INTO area_revisions(id,content_release_id,area_id,display_name,active) VALUES ($1,$2,$3,$4,TRUE)",
        [randomUUID(), releaseId, id, slug],
      );
    }
    await pool.query("INSERT INTO pokemon_types(id,slug) VALUES ($1,'normal')", [typeId]);
    for (const [id, formId, dex, slug] of [
      [knownSpeciesId, knownFormId, 987, "exp-known"],
      [unknownSpeciesId, unknownFormId, 988, "exp-unknown"],
    ] as const) {
      await pool.query(
        "INSERT INTO pokemon_species(id,national_dex,slug) VALUES ($1,$2,$3)",
        [id, dex, slug],
      );
      await pool.query(
        "INSERT INTO pokemon_forms(id,species_id,slug) VALUES ($1,$2,'default')",
        [formId, id],
      );
      await pool.query(
        "INSERT INTO pokemon_species_revisions(id,content_release_id,species_id,display_name,active) VALUES ($1,$2,$3,'Fixture Species',TRUE)",
        [randomUUID(), releaseId, id],
      );
      await pool.query(
        `INSERT INTO pokemon_form_revisions(
          id,content_release_id,form_id,display_name,type1_id,
          base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed,active
        ) VALUES ($1,$2,$3,'Fixture Form',$4,40,40,40,40,40,40,TRUE)`,
        [randomUUID(), releaseId, formId, typeId],
      );
    }
    await pool.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [
      playerId,
      otherPlayerId,
    ]);
    await pool.query(
      "INSERT INTO onboarding_states(player_id,state,completed_at) VALUES ($1,'COMPLETE',now()),($2,'COMPLETE',now())",
      [playerId, otherPlayerId],
    );
    await pool.query("INSERT INTO player_locations(player_id,area_id) VALUES ($1,$2),($3,$2)", [
      playerId,
      villageId,
      otherPlayerId,
    ]);
    await pool.query(
      "INSERT INTO player_pokedex_species(player_id,species_id,seen_count,caught_count,first_seen_at,last_seen_at) VALUES ($1,$2,1,0,now(),now())",
      [playerId, knownSpeciesId],
    );
    await pool.query(
      "INSERT INTO encounter_tables(id,area_id,slug) VALUES ($1,$2,'day-land')",
      [tableId, villageId],
    );
    await pool.query(
      "INSERT INTO encounter_table_revisions(id,content_release_id,encounter_table_id,active,conditions) VALUES ($1,$2,$3,TRUE,$4::jsonb)",
      [revisionId, releaseId, tableId, conditions({ timeOfDay: "DAY", surface: "LAND" })],
    );
    for (const [id, formId, weight, entryConditions] of [
      [entries.known, knownFormId, 10, conditions()],
      [entries.unknown, unknownFormId, 90, conditions()],
      [entries.locked, knownFormId, 70, conditions({ requiredUnlockKeys: ["exp.unlock"] })],
      [entries.night, knownFormId, 50, conditions({ timeOfDay: "NIGHT" })],
      [entries.water, knownFormId, 35, conditions({ surface: "WATER" })],
    ] as const) {
      await pool.query(
        "INSERT INTO encounter_entries(id,encounter_table_revision_id,form_id,weight,min_level,max_level,active,conditions) VALUES ($1,$2,$3,$4,2,6,TRUE,$5::jsonb)",
        [id, revisionId, formId, weight, entryConditions],
      );
    }
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

  function query(overrides: Record<string, unknown> = {}) {
    return {
      playerId,
      contentReleaseId: releaseId,
      areaId: villageId,
      encounterTableSlug: "day-land",
      environment: dayLand,
      ...overrides,
    };
  }

  beforeAll(async () => {
    const connection = process.env.POSTGRES_INTEGRATION_TEST_URL;
    if (connection === undefined) throw new Error("Disposable PostgreSQL URL missing");
    const root = new URL(connection);
    root.pathname = "/postgres";
    admin = new Pool({ connectionString: root.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const local = new URL(connection);
    local.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: local.toString(), max: 4 });
    await runMigrations(pool, { appliedBy: "expedition-eligible-vitest" });
    await seed();
    reader = new PostgresEligibleExpeditionPoolReader(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
  }, 30_000);

  it("filters release-pinned DAY/LAND entries and reads only this player's seen species", async () => {
    const result = await reader.read(query());
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.knownSpeciesIds).toEqual([knownSpeciesId]);
    expect(result.pool.contentReleaseId).toBe(releaseId);
    expect(result.pool.areaId).toBe(villageId);
    expect(result.pool.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryId: entries.known, speciesId: knownSpeciesId, weight: 10 }),
        expect.objectContaining({ entryId: entries.unknown, speciesId: unknownSpeciesId, weight: 90 }),
      ]),
    );
    expect(result.pool.entries).toHaveLength(2);
    const weighted = prepareExpeditionEncounterWeights({
      admission: { contentReleaseId: releaseId, currentAreaId: villageId },
      ...result,
      targetSpeciesId: knownSpeciesId,
    });
    expect(weighted).toMatchObject({ ok: true, value: { totalEffectiveWeight: 120 } });
    if (!weighted.ok) return;
    expect(weighted.value.entries.map((entry) => entry.effectiveWeight).sort((a, b) => a - b)).toEqual([30, 90]);
  });

  it("rejects wrong area, unread Pokédex, invalid conditions and absent table without leakage", async () => {
    expect(await reader.read(query({ areaId: yunId }))).toBeNull();
    expect(await reader.read(query({ contentReleaseId: randomUUID() }))).toBeNull();
    expect(await reader.read(query({ encounterTableSlug: "unknown" }))).toBeNull();
    expect(await reader.read(query({ encounterTableSlug: "../day-land" }))).toBeNull();
    expect(await reader.read(query({ environment: { timeOfDay: "NIGHT", surface: "LAND" } }))).toBeNull();
    expect(await reader.read(query({ environment: { timeOfDay: "DAY", surface: "WATER" } }))).toBeNull();
    const other = await reader.read(query({ playerId: otherPlayerId }));
    expect(other?.knownSpeciesIds).toEqual([]);
    expect(other?.pool.entries).toHaveLength(2);
  });

  it("only unlocks catalog entries when the owner earns the required unlock", async () => {
    expect((await reader.read(query()))?.pool.entries).toHaveLength(2);
    await pool.query(
      "INSERT INTO trainer_unlocks(player_id,unlock_key,source_type,source_id,status) VALUES ($1,'exp.unlock','TEST','eligibility','ACTIVE')",
      [playerId],
    );
    const unlocked = await reader.read(query());
    expect(unlocked?.pool.entries.map((entry) => entry.entryId)).toEqual([
      entries.known,
      entries.unknown,
      entries.locked,
    ].sort());
  });

  it("denies suspended and mechanically incomplete players, even with matching location", async () => {
    await pool.query("UPDATE players SET status='SUSPENDED' WHERE id=$1", [playerId]);
    expect(await reader.read(query())).toBeNull();
    await pool.query("UPDATE players SET status='ACTIVE' WHERE id=$1", [playerId]);
    await pool.query(
      "UPDATE onboarding_states SET state='STARTER_GRANTED',completed_at=NULL WHERE player_id=$1",
      [playerId],
    );
    expect(await reader.read(query())).toBeNull();
    await pool.query(
      "UPDATE onboarding_states SET state='COMPLETE',completed_at=now() WHERE player_id=$1",
      [playerId],
    );
  });

  it("does not authorize unpinned content after the release pointer disappears", async () => {
    await pool.query("DELETE FROM content_release_pointers WHERE pointer_key='ACTIVE'");
    expect(await reader.read(query())).toBeNull();
  });
});
