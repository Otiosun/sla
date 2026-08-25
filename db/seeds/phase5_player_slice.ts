import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";
import { withTransaction } from "../../src/platform/db/transaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 5 player-slice seed");
}

const RELEASE_NO = 2n;
const RELEASE_NAME = "Phase 5 Player Slice v1";

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function activeReleaseId(client: PoolClient): Promise<string> {
  const result = await client.query<{ content_release_id: string }>(
    "SELECT content_release_id FROM content_release_pointers WHERE pointer_key = 'ACTIVE'",
  );
  const id = result.rows[0]?.content_release_id;
  if (id === undefined) throw new Error("Phase 4 ACTIVE release is required before Phase 5 seed");
  return id;
}

async function resolveRelease(client: PoolClient): Promise<{
  readonly id: string;
  readonly status: "DRAFT" | "VALIDATED" | "PUBLISHED";
  readonly parentReleaseId: string | null;
}> {
  const result = await client.query<{
    id: string;
    status: "DRAFT" | "VALIDATED" | "PUBLISHED";
    parent_release_id: string | null;
    name: string;
  }>(
    `SELECT id, status, parent_release_id, name FROM content_releases WHERE release_no = $1`,
    [RELEASE_NO.toString()],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Phase 5 release was not created");
  if (row.name !== RELEASE_NAME) throw new Error("Release 2 is bound to unexpected content");
  return { id: row.id, status: row.status, parentReleaseId: row.parent_release_id };
}

async function seedStarterOptions(client: PoolClient, releaseId: string): Promise<void> {
  const region = await client.query<{ id: string }>("SELECT id FROM regions WHERE slug = 'kanto'");
  const regionId = region.rows[0]?.id;
  if (regionId === undefined) throw new Error("Kanto identity is missing");

  const starters = [
    ["bulbasaur", 1],
    ["charmander", 2],
    ["squirtle", 3],
  ] as const;
  for (const [speciesSlug, sortOrder] of starters) {
    const form = await client.query<{ id: string }>(
      `SELECT form.id
       FROM pokemon_forms form
       JOIN pokemon_species species ON species.id = form.species_id
       WHERE species.slug = $1 AND form.slug = 'default'`,
      [speciesSlug],
    );
    const formId = form.rows[0]?.id;
    if (formId === undefined) throw new Error(`Starter form is missing: ${speciesSlug}`);
    await client.query(
      `INSERT INTO starter_options(
         id, content_release_id, region_id, form_id, starter_level, sort_order, active
       ) VALUES ($1, $2, $3, $4, 5, $5, TRUE)
       ON CONFLICT (content_release_id, region_id, form_id) DO NOTHING`,
      [randomUUID(), releaseId, regionId, formId, sortOrder],
    );
  }
}

async function verifyStarterOptions(client: PoolClient, releaseId: string): Promise<void> {
  const result = await client.query<{ slug: string; starter_level: number; sort_order: number }>(
    `SELECT species.slug, starter.starter_level, starter.sort_order
     FROM starter_options starter
     JOIN pokemon_forms form ON form.id = starter.form_id
     JOIN pokemon_species species ON species.id = form.species_id
     JOIN regions region ON region.id = starter.region_id
     WHERE starter.content_release_id = $1 AND region.slug = 'kanto' AND starter.active = TRUE
     ORDER BY starter.sort_order`,
    [releaseId],
  );
  const actual = result.rows.map((row) => [row.slug, row.starter_level, row.sort_order]);
  const expected = [
    ["bulbasaur", 5, 1],
    ["charmander", 5, 2],
    ["squirtle", 5, 3],
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Phase 5 starter options differ from canonical seed: ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const migrations = await loadMigrations();
    const verifyClient = await pool.connect();
    try {
      await verifyAppliedMigrations(verifyClient, migrations, true);
    } finally {
      verifyClient.release();
    }

    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    let release = await withTransaction(pool, async (client) => {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM content_releases WHERE release_no = $1",
        [RELEASE_NO.toString()],
      );
      if (existing.rows[0] !== undefined) return resolveRelease(client);
      const parentReleaseId = await activeReleaseId(client);
      const newReleaseId = randomUUID();
      unwrap(
        "clone Phase 4 release",
        await catalog.clonePublishedRelease({
          parentReleaseId,
          newReleaseId,
          releaseNo: RELEASE_NO,
          name: RELEASE_NAME,
        }),
      );
      return resolveRelease(client);
    });

    if (release.status === "DRAFT") {
      await withTransaction(pool, async (client) => seedStarterOptions(client, release.id));
      unwrap("validate Phase 5 release", await catalog.validateRelease(release.id));
      release = await withTransaction(pool, resolveRelease);
    }
    if (release.status === "VALIDATED") {
      unwrap("publish Phase 5 release", await catalog.publishRelease(release.id));
      release = await withTransaction(pool, resolveRelease);
    }
    if (release.status !== "PUBLISHED") throw new Error(`Unexpected Phase 5 status: ${release.status}`);

    unwrap("activate Phase 5 release", await catalog.activateRelease(release.id));
    await withTransaction(pool, async (client) => verifyStarterOptions(client, release.id));
    console.log(`Phase 5 player slice ready: release ${release.id}`);
  } finally {
    await pool.end();
  }
}

await main();
