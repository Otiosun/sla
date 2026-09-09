import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPlayerPortalCatalogResolver } from "../../src/platform/player-portal/postgres-player-portal-catalog-resolver.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("Player Portal catalog resolver on disposable PostgreSQL", () => {
  const dbName = `pokemon_portal_catalog_${process.pid}_${Date.now()}`;
  const rulesetId = "11111111-1111-4111-8111-111111111111";
  const releaseId = "22222222-2222-4222-8222-222222222222";
  const regionId = "33333333-3333-4333-8333-333333333333";
  const fireTypeId = "44444444-4444-4444-8444-444444444444";
  const speciesId = "55555555-5555-4555-8555-555555555555";
  const formId = "66666666-6666-4666-8666-666666666666";
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "player-portal-catalog-vitest" });

    await pool.query(
      `INSERT INTO rulesets(
         id, key, version, engine_contract_version, config, status, published_at
       ) VALUES ($1, 'portal-test', 1, 1, '{}'::jsonb, 'PUBLISHED', now())`,
      [rulesetId],
    );
    await pool.query(
      `INSERT INTO content_releases(
         id, release_no, name, status, default_ruleset_id, published_at
       ) VALUES ($1, 999999, 'Portal Test', 'PUBLISHED', $2, now())`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO regions(id, slug) VALUES ($1, 'kanto')", [regionId]);
    await pool.query(
      `INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active)
       VALUES ('77777777-7777-4777-8777-777777777777', $1, $2, 'Kanto', TRUE)`,
      [releaseId, regionId],
    );
    await pool.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, 'fire')", [fireTypeId]);
    await pool.query(
      `INSERT INTO pokemon_type_revisions(
         id, content_release_id, type_id, display_name, active
       ) VALUES ('88888888-8888-4888-8888-888888888888', $1, $2, 'Fire', TRUE)`,
      [releaseId, fireTypeId],
    );
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 4, 'charmander')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
      formId,
      speciesId,
    ]);
    await pool.query(
      `INSERT INTO pokemon_form_revisions(
         id, content_release_id, form_id, display_name, type1_id, type2_id,
         base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed, active
       ) VALUES (
         '99999999-9999-4999-8999-999999999999', $1, $2, 'Charmander', $3, NULL,
         39, 52, 43, 60, 50, 65, TRUE
       )`,
      [releaseId, formId, fireTypeId],
    );
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("resolves release-scoped region and form presentation in one bounded catalog read", async () => {
    const resolver = new PostgresPlayerPortalCatalogResolver(pool);

    await expect(
      resolver.resolve({
        contentReleaseId: releaseId,
        originRegionId: regionId,
        formIds: [formId],
      }),
    ).resolves.toEqual({
      originRegionName: "Kanto",
      forms: [
        {
          formId,
          displayName: "Charmander",
          nationalDex: 4,
          typeNames: ["Fire"],
        },
      ],
    });
  });

  it("returns honest empty presentation for catalog ids absent from the selected release", async () => {
    const resolver = new PostgresPlayerPortalCatalogResolver(pool);

    await expect(
      resolver.resolve({
        contentReleaseId: releaseId,
        originRegionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        formIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      }),
    ).resolves.toEqual({ originRegionName: null, forms: [] });
  });
});
