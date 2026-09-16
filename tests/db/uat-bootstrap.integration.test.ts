import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UatBootstrapService } from "../../src/modules/admin/uat-bootstrap.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { SystemClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { CryptoRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";

const databaseUrl = (() => {
  const value = process.env.POSTGRES_INTEGRATION_TEST_URL;
  if (value === undefined) {
    throw new Error("POSTGRES_INTEGRATION_TEST_URL is required for disposable integration tests");
  }
  return value;
})();

const integrationDatabaseUrl = new URL(databaseUrl);
if (integrationDatabaseUrl.pathname !== "/postgres") {
  throw new Error(
    "POSTGRES_INTEGRATION_TEST_URL must target the maintenance database named postgres",
  );
}
if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
  throw new Error(
    "ALLOW_DISPOSABLE_POSTGRES_TESTS=1 is required before creating a disposable database",
  );
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function seedUatFixture(client: PoolClient): Promise<void> {
  const ids = Object.fromEntries(
    [
      "ruleset",
      "release",
      "type",
      "species",
      "form",
      "move",
      "ability",
      "nature",
      "region",
      "area",
    ].map((key) => [key, randomUUID()]),
  ) as Record<string, string>;
  await client.query(
    `INSERT INTO rulesets(id,key,version,engine_contract_version,config,status,validated_at,validation_report,config_fingerprint,published_at)
     VALUES ($1,'uat-bootstrap-test',1,1,'{}','PUBLISHED',now(),'{"valid":true,"issues":[]}', $2, now())`,
    [ids.ruleset, "a".repeat(64)],
  );
  await client.query(
    `INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id,validated_at,validation_report,content_fingerprint,published_at)
     VALUES ($1,1,'UAT Bootstrap Test','PUBLISHED',$2,now(),'{"valid":true,"issues":[]}', $3,now())`,
    [ids.release, ids.ruleset, "b".repeat(64)],
  );
  await client.query("INSERT INTO pokemon_types(id,slug) VALUES ($1,'normal')", [ids.type]);
  await client.query(
    "INSERT INTO pokemon_species(id,national_dex,slug) VALUES ($1,1,'bulbasaur')",
    [ids.species],
  );
  await client.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES ($1,$2,'default')", [
    ids.form,
    ids.species,
  ]);
  await client.query("INSERT INTO moves(id,slug) VALUES ($1,'tackle')", [ids.move]);
  await client.query("INSERT INTO abilities(id,slug) VALUES ($1,'overgrow')", [ids.ability]);
  await client.query("INSERT INTO natures(id,slug) VALUES ($1,'hardy')", [ids.nature]);
  await client.query("INSERT INTO regions(id,slug) VALUES ($1,'kanto')", [ids.region]);
  await client.query("INSERT INTO areas(id,region_id,slug) VALUES ($1,$2,'pallet-town')", [
    ids.area,
    ids.region,
  ]);
  await client.query(
    `INSERT INTO pokemon_species_revisions(id,content_release_id,species_id,display_name,catch_rate,base_exp)
     VALUES ($1,$2,$3,'Bulbasaur',45,64)`,
    [randomUUID(), ids.release, ids.species],
  );
  await client.query(
    `INSERT INTO pokemon_form_revisions(id,content_release_id,form_id,display_name,type1_id,base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed)
     VALUES ($1,$2,$3,'Bulbasaur',$4,45,49,49,65,65,45)`,
    [randomUUID(), ids.release, ids.form, ids.type],
  );
  await client.query(
    `INSERT INTO move_revisions(id,content_release_id,move_id,display_name,type_id,category,power,accuracy,priority,max_pp)
     VALUES ($1,$2,$3,'Tackle',$4,'PHYSICAL',40,100,0,35)`,
    [randomUUID(), ids.release, ids.move, ids.type],
  );
  await client.query(
    "INSERT INTO ability_revisions(id,content_release_id,ability_id,display_name) VALUES ($1,$2,$3,'Overgrow')",
    [randomUUID(), ids.release, ids.ability],
  );
  await client.query(
    "INSERT INTO nature_revisions(id,content_release_id,nature_id,display_name) VALUES ($1,$2,$3,'Hardy')",
    [randomUUID(), ids.release, ids.nature],
  );
  await client.query(
    `INSERT INTO region_revisions(id,content_release_id,region_id,display_name,active,data)
     VALUES ($1,$2,$3,'Kanto',TRUE,'{}')`,
    [randomUUID(), ids.release, ids.region],
  );
  await client.query(
    `INSERT INTO area_revisions(id,content_release_id,area_id,display_name,active,data)
     VALUES ($1,$2,$3,'Pallet Town',TRUE,'{"schemaVersion":1,"kind":"TOWN","safePoint":true,"startingArea":true,"relocationPriority":0}')`,
    [randomUUID(), ids.release, ids.area],
  );
  await client.query(
    `INSERT INTO pokemon_form_ability_options(id,content_release_id,form_id,ability_id,slot_kind)
     VALUES ($1,$2,$3,$4,'PRIMARY')`,
    [randomUUID(), ids.release, ids.form, ids.ability],
  );
  await client.query(
    `INSERT INTO move_learnset_entries(id,content_release_id,form_id,move_id,learn_method)
     VALUES ($1,$2,$3,$4,'START')`,
    [randomUUID(), ids.release, ids.form, ids.move],
  );
  await client.query(
    `INSERT INTO starter_options(id,content_release_id,region_id,form_id,starter_level,sort_order)
     VALUES ($1,$2,$3,$4,5,1)`,
    [randomUUID(), ids.release, ids.region, ids.form],
  );
  await client.query(
    "INSERT INTO content_release_pointers(pointer_key,content_release_id) VALUES ('ACTIVE',$1)",
    [ids.release],
  );
}

describe.sequential("UAT bootstrap on disposable PostgreSQL", () => {
  const dbName = `pokemon_uat_bootstrap_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "uat-bootstrap-vitest" });
    const client = await pool.connect();
    try {
      await seedUatFixture(client);
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminPool.end();
    }
  }, 30_000);

  it("creates, replays, prepares a pair, reports status, and survives service recreation", async () => {
    const repository = new PostgresPlayerOnboardingRepository(pool);
    const players = new PlayerRegistrationService(repository);
    const starter = new PlayerStarterService(
      repository,
      new SystemClock(),
      new CryptoRandomSource(),
    );
    const world = new WorldService(new PostgresWorldRepository(pool), {
      enabled: true,
      reason: null,
    });
    const service = () => new UatBootstrapService(pool, players, starter, world);
    const suffix = randomUUID();
    const actor = randomUUID();
    const a = `uat-a-${suffix}`;
    const b = `uat-b-${suffix}`;
    await pool.query(
      "INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')",
      [actor, `uat:${suffix}`],
    );
    const first = await service().bootstrap({ provider: "whatsapp", externalId: a }, actor);
    expect(first).toMatchObject({
      ok: true,
      value: { access: "ACTIVE", uat: true, roster: true },
    });
    if (!first.ok) return;
    const replay = await service().bootstrap({ provider: "whatsapp", externalId: a }, actor);
    expect(replay).toMatchObject({ ok: true, value: { playerId: first.value.playerId } });
    const pair = await service().prepare(
      { provider: "whatsapp", externalId: a },
      { provider: "whatsapp", externalId: b },
      actor,
    );
    expect(pair.ok).toBe(true);
    expect(
      (
        await service().prepare(
          { provider: "whatsapp", externalId: a },
          { provider: "whatsapp", externalId: b },
          actor,
        )
      ).ok,
    ).toBe(true);
    const counts = await pool.query<{
      identity_count: string;
      starter_count: string;
      roster_count: string;
      access_count: string;
      marker_count: string;
      party_count: string;
      area_count: string;
    }>(
      `SELECT (SELECT count(*) FROM player_identities WHERE external_id = $1) identity_count, (SELECT count(*) FROM starter_grants WHERE player_id = $2) starter_count, (SELECT count(*) FROM pokemon_roster_slots WHERE player_id = $2) roster_count, (SELECT count(*) FROM player_access WHERE player_id = $2 AND status = 'ACTIVE' AND access_origin = 'UAT_BOOTSTRAP') access_count, (SELECT count(*) FROM player_uat_bootstraps WHERE player_id = $2) marker_count, (SELECT count(DISTINCT party_id) FROM player_party_members WHERE player_id = ANY($3::uuid[]) AND active) party_count, (SELECT count(DISTINCT area_id) FROM player_locations WHERE player_id = ANY($3::uuid[])) area_count`,
      [a, first.value.playerId, [first.value.playerId, pair.ok ? pair.value[1]?.playerId : ""]],
    );
    expect(counts.rows[0]).toMatchObject({
      identity_count: "1",
      starter_count: "1",
      roster_count: "1",
      access_count: "1",
      marker_count: "1",
      party_count: "1",
      area_count: "1",
    });
    const status = await service().status({ provider: "whatsapp", externalId: a });
    expect(status).toMatchObject({
      ok: true,
      value: expect.stringMatching(/TEST\/UAT.*ACTIVE.*Ãrea.*Party.*Roster.*PVE: apto.*PVP: apto/),
    });
    if (status.ok) expect(status.value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  }, 30_000);
});
