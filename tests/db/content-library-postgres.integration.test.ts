import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresContentLibraryRepository } from "../../src/platform/catalog/postgres-content-library-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

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

const RULESET_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const SPECIES_ID = "33333333-3333-4333-8333-333333333333";
const SPECIES_REVISION_ID = "44444444-4444-4444-8444-444444444444";

describe.sequential("PostgresContentLibraryRepository", () => {
  const dbName = `pokemon_content_library_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "content-library-proof" });

    await pool.query(
      `INSERT INTO rulesets (id, key, version, engine_contract_version, config, status)
       VALUES ($1, 'content-library-proof', 1, 1, '{}'::jsonb, 'DRAFT')`,
      [RULESET_ID],
    );
    await pool.query(
      `INSERT INTO content_releases (id, release_no, name, status, default_ruleset_id)
       VALUES ($1, 91, 'Kanto proof', 'DRAFT', $2)`,
      [RELEASE_ID, RULESET_ID],
    );
    await pool.query(
      `INSERT INTO pokemon_species (id, national_dex, slug)
       VALUES ($1, 25, 'pikachu')`,
      [SPECIES_ID],
    );
    await pool.query(
      `INSERT INTO pokemon_species_revisions (
         id, content_release_id, species_id, display_name, active
       ) VALUES ($1, $2, $3, 'Pikachu', TRUE)`,
      [SPECIES_REVISION_ID, RELEASE_ID, SPECIES_ID],
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

  it("executes the seven-kind unified query against the migrated schema", async () => {
    const repository = new PostgresContentLibraryRepository(pool);
    const result = await repository.searchContent({
      query: "pika",
      resourceKind: "SPECIES",
      releaseStatus: "DRAFT",
      active: true,
      limit: 30,
      cursor: null,
    });

    expect(result).toEqual({
      items: [
        {
          releaseId: RELEASE_ID,
          releaseNo: "91",
          releaseName: "Kanto proof",
          releaseStatus: "DRAFT",
          releaseRevision: "0",
          resourceKind: "SPECIES",
          resourceId: SPECIES_ID,
          slug: "pikachu",
          displayName: "Pikachu",
          active: true,
        },
      ],
      nextCursor: null,
    });
  });
});
