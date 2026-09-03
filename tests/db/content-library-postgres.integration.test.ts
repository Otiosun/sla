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
const PUBLISHED_RELEASE_ID = "66666666-6666-4666-8666-666666666666";
const DRAFT_RELEASE_ID = "77777777-7777-4777-8777-777777777777";
const VALIDATED_RELEASE_ID = "88888888-8888-4888-8888-888888888888";

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

  it("lists only DRAFT and VALIDATED releases with append-only change evidence", async () => {
    await pool.query(
      `INSERT INTO content_releases (
         id, release_no, name, status, default_ruleset_id, revision, created_at
       ) VALUES (
         $1, 90, 'Published control', 'DRAFT', $2, 1, '2026-08-31T19:00:00.000Z'
       )`,
      [PUBLISHED_RELEASE_ID, RULESET_ID],
    );
    await pool.query(
      `UPDATE content_releases
       SET status = 'VALIDATED',
           validated_at = '2026-08-31T19:30:00.000Z',
           validation_report = '{}'::jsonb,
           content_fingerprint = $2
       WHERE id = $1`,
      [PUBLISHED_RELEASE_ID, "a".repeat(64)],
    );
    await pool.query(
      `UPDATE content_releases
       SET status = 'PUBLISHED', published_at = '2026-08-31T20:00:00.000Z'
       WHERE id = $1`,
      [PUBLISHED_RELEASE_ID],
    );

    await pool.query(
      `INSERT INTO content_releases (
         id, release_no, name, status, parent_release_id, default_ruleset_id,
         revision, created_at
       ) VALUES (
         $1, 93, 'Kanto editing', 'DRAFT', $2, $3,
         2, '2026-08-31T22:00:00.000Z'
       )`,
      [DRAFT_RELEASE_ID, PUBLISHED_RELEASE_ID, RULESET_ID],
    );
    await pool.query(
      `INSERT INTO content_releases (
         id, release_no, name, status, parent_release_id, default_ruleset_id,
         revision, created_at
       ) VALUES (
         $1, 92, 'Kanto ready', 'DRAFT', $2, $3,
         1, '2026-08-31T20:00:00.000Z'
       )`,
      [VALIDATED_RELEASE_ID, PUBLISHED_RELEASE_ID, RULESET_ID],
    );

    const claims = [
      {
        id: "99999999-9999-4999-8999-999999999999",
        releaseId: DRAFT_RELEASE_ID,
        resourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        idempotencyKey: "draft-change-1",
        fingerprint: "1".repeat(64),
        beforeRevision: 0,
        afterRevision: 1,
        correlationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        createdAt: "2026-08-31T22:10:00.000Z",
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        releaseId: DRAFT_RELEASE_ID,
        resourceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        idempotencyKey: "draft-change-2",
        fingerprint: "2".repeat(64),
        beforeRevision: 1,
        afterRevision: 2,
        correlationId: "12121212-1212-4212-8212-121212121212",
        createdAt: "2026-08-31T22:20:00.000Z",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        releaseId: VALIDATED_RELEASE_ID,
        resourceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        idempotencyKey: "validated-change-1",
        fingerprint: "3".repeat(64),
        beforeRevision: 0,
        afterRevision: 1,
        correlationId: "13131313-1313-4313-8313-131313131313",
        createdAt: "2026-08-31T20:30:00.000Z",
      },
    ];

    for (const claim of claims) {
      await pool.query(
        `INSERT INTO catalog_admin_operation_claims (
           id, operation_kind, content_release_id, resource_kind, resource_id,
           idempotency_key, request_fingerprint, before_revision, after_revision,
           before_data, after_data, result, correlation_id, created_at
         ) VALUES (
           $1, 'REPLACE', $2, 'SPECIES', $3,
           $4, $5, $6, $7,
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $8, $9
         )`,
        [
          claim.id,
          claim.releaseId,
          claim.resourceId,
          claim.idempotencyKey,
          claim.fingerprint,
          claim.beforeRevision,
          claim.afterRevision,
          claim.correlationId,
          claim.createdAt,
        ],
      );
    }

    await pool.query(
      `UPDATE content_releases
       SET status = 'VALIDATED',
           validated_at = '2026-08-31T21:00:00.000Z',
           validation_report = '{}'::jsonb,
           content_fingerprint = $2
       WHERE id = $1`,
      [VALIDATED_RELEASE_ID, "b".repeat(64)],
    );

    const repository = new PostgresContentLibraryRepository(pool);
    const result = await repository.listUnpublished();

    expect(result).toEqual([
      {
        releaseId: DRAFT_RELEASE_ID,
        releaseNo: "93",
        releaseName: "Kanto editing",
        status: "DRAFT",
        workflowState: "EDITING",
        revision: "2",
        parentReleaseId: PUBLISHED_RELEASE_ID,
        createdAt: "2026-08-31T22:00:00.000Z",
        validatedAt: null,
        recordedChangeCount: "2",
        lastChangedAt: "2026-08-31T22:20:00.000Z",
      },
      {
        releaseId: VALIDATED_RELEASE_ID,
        releaseNo: "92",
        releaseName: "Kanto ready",
        status: "VALIDATED",
        workflowState: "READY_TO_PUBLISH",
        revision: "1",
        parentReleaseId: PUBLISHED_RELEASE_ID,
        createdAt: "2026-08-31T20:00:00.000Z",
        validatedAt: "2026-08-31T21:00:00.000Z",
        recordedChangeCount: "1",
        lastChangedAt: "2026-08-31T20:30:00.000Z",
      },
      {
        releaseId: RELEASE_ID,
        releaseNo: "91",
        releaseName: "Kanto proof",
        status: "DRAFT",
        workflowState: "EDITING",
        revision: "0",
        parentReleaseId: null,
        createdAt: expect.any(String),
        validatedAt: null,
        recordedChangeCount: "0",
        lastChangedAt: null,
      },
    ]);
  });
});
