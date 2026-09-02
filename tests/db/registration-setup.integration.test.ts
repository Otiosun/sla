import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresRegistrationSetupLoader } from "../../src/platform/registration/postgres-registration-setup-loader.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function seedSetup(client: PoolClient) {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const typeId = randomUUID();
  const zhouliaId = randomUUID();
  const otherRegionId = randomUUID();
  const charmanderSpeciesId = randomUUID();
  const charmanderFormId = randomUUID();
  const squirtleSpeciesId = randomUUID();
  const squirtleFormId = randomUUID();
  const hiddenSpeciesId = randomUUID();
  const hiddenFormId = randomUUID();

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'registration-setup-test', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "a".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 1, 'registration-setup-release', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, 'fire')", [typeId]);
  await client.query(
    "INSERT INTO regions(id, slug) VALUES ($1, 'zhoulia'), ($2, 'other-region')",
    [zhouliaId, otherRegionId],
  );

  const species = [
    [charmanderSpeciesId, 4, "charmander"],
    [squirtleSpeciesId, 7, "squirtle"],
    [hiddenSpeciesId, 1, "hiddenmon"],
  ] as const;
  for (const [id, dex, slug] of species) {
    await client.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, $2, $3)",
      [id, dex, slug],
    );
  }
  const forms = [
    [charmanderFormId, charmanderSpeciesId],
    [squirtleFormId, squirtleSpeciesId],
    [hiddenFormId, hiddenSpeciesId],
  ] as const;
  for (const [formId, speciesId] of forms) {
    await client.query(
      "INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')",
      [formId, speciesId],
    );
  }

  await client.query(
    `INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active)
     VALUES ($1, $2, $3, 'Zhoulia', TRUE), ($4, $2, $5, 'Outra', TRUE)`,
    [randomUUID(), releaseId, zhouliaId, randomUUID(), otherRegionId],
  );
  const formRevisions = [
    [charmanderFormId, "Charmander", true],
    [squirtleFormId, "Squirtle", true],
    [hiddenFormId, "Hiddenmon", true],
  ] as const;
  for (const [formId, displayName, active] of formRevisions) {
    await client.query(
      `INSERT INTO pokemon_form_revisions(
         id, content_release_id, form_id, display_name, type1_id,
         base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed, active
       ) VALUES ($1, $2, $3, $4, $5, 45, 45, 45, 45, 45, 45, $6)`,
      [randomUUID(), releaseId, formId, displayName, typeId, active],
    );
  }

  await client.query(
    `INSERT INTO starter_options(
       id, content_release_id, region_id, form_id, starter_level, sort_order, active
     ) VALUES
       ($1, $2, $3, $4, 5, 2, TRUE),
       ($5, $2, $3, $6, 5, 1, TRUE),
       ($7, $2, $3, $8, 5, 0, FALSE),
       ($9, $2, $10, $8, 5, 0, TRUE)`,
    [
      randomUUID(),
      releaseId,
      zhouliaId,
      charmanderFormId,
      randomUUID(),
      squirtleFormId,
      randomUUID(),
      hiddenFormId,
      randomUUID(),
      otherRegionId,
    ],
  );
  await client.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "b".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
  await client.query(
    "INSERT INTO content_release_pointers(pointer_key, content_release_id) VALUES ('ACTIVE', $1)",
    [releaseId],
  );

  return { zhouliaId, charmanderFormId, squirtleFormId };
}

describe.sequential("PostgresRegistrationSetupLoader", () => {
  const dbName = `pokemon_registration_setup_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let expected: Awaited<ReturnType<typeof seedSetup>>;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "registration-setup-vitest" });
    const client = await pool.connect();
    try {
      expected = await seedSetup(client);
    } finally {
      client.release();
    }
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

  it("loads Zhoulia and only its active canonical starters from the active published release", async () => {
    const loader = new PostgresRegistrationSetupLoader(pool);

    expect(await loader.load()).toEqual({
      ok: true,
      value: {
        regionId: expected.zhouliaId,
        regionDisplayName: "Zhoulia",
        starterOptions: [
          { formId: expected.squirtleFormId, displayName: "Squirtle" },
          { formId: expected.charmanderFormId, displayName: "Charmander" },
        ],
      },
    });
  });
});
