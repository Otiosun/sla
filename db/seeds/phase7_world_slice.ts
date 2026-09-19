import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { ZHOULIA_TYPED_CONTENT_V1 } from "../../src/modules/world/zhoulia-content.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";
import { withTransaction } from "../../src/platform/db/transaction.js";
import {
  assertZhouliaExclusiveRelease,
  reconcileZhouliaExclusiveRelease,
  type ZhouliaStarterOptionInput,
} from "../../src/platform/world/postgres-zhoulia-exclusive-release.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 7 world-slice seed");
}

const RELEASE_NO = 4n;
const RELEASE_NAME = "Phase 7 Zhoulia World Slice v2";
const EXPECTED_PARENT_RELEASE_NO = 3n;

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function activeRelease(client: PoolClient): Promise<{ id: string; releaseNo: bigint }> {
  const result = await client.query<{ content_release_id: string; release_no: string }>(
    `SELECT pointer.content_release_id, release.release_no::text
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id=pointer.content_release_id
      WHERE pointer.pointer_key='ACTIVE'`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("An ACTIVE release is required before Phase 7 seed");
  return { id: row.content_release_id, releaseNo: BigInt(row.release_no) };
}

async function resolveRelease(client: PoolClient): Promise<{
  readonly id: string;
  readonly status: "DRAFT" | "VALIDATED" | "PUBLISHED";
  readonly parentReleaseNo: bigint | null;
}> {
  const result = await client.query<{
    id: string;
    status: "DRAFT" | "VALIDATED" | "PUBLISHED";
    name: string;
    parent_release_no: string | null;
  }>(
    `SELECT release.id, release.status, release.name, parent.release_no::text AS parent_release_no
       FROM content_releases release
       LEFT JOIN content_releases parent ON parent.id=release.parent_release_id
      WHERE release.release_no=$1`,
    [RELEASE_NO.toString()],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Phase 7 release was not created");
  if (row.name !== RELEASE_NAME) {
    throw new Error(`Release 4 is bound to unexpected content: ${row.name}`);
  }
  return {
    id: row.id,
    status: row.status,
    parentReleaseNo: row.parent_release_no === null ? null : BigInt(row.parent_release_no),
  };
}

async function ensureTestOnlyZhouliaSpeciesFixture(
  client: PoolClient,
  releaseId: string,
): Promise<void> {
  if (process.env.APP_ENV !== "test") return;

  const type = await client.query<{ id: string }>(
    `SELECT revision.type_id AS id
       FROM pokemon_type_revisions revision
       JOIN pokemon_types identity ON identity.id=revision.type_id
      WHERE revision.content_release_id=$1
        AND revision.active=TRUE
        AND identity.slug='normal'
      LIMIT 1`,
    [releaseId],
  );
  const typeId = type.rows[0]?.id;
  if (typeId === undefined) throw new Error("Phase 7 test fixture requires active Normal type");

  const ability = await client.query<{ id: string }>(
    `SELECT ability_id AS id
       FROM ability_revisions
      WHERE content_release_id=$1 AND active=TRUE
      ORDER BY display_name,ability_id
      LIMIT 1`,
    [releaseId],
  );
  const abilityId = ability.rows[0]?.id;
  if (abilityId === undefined) throw new Error("Phase 7 test fixture requires an active ability");

  const move = await client.query<{ id: string }>(
    `SELECT move_id AS id
       FROM move_revisions
      WHERE content_release_id=$1
        AND active=TRUE
        AND power IS NOT NULL
        AND power>0
        AND max_pp>0
      ORDER BY display_name,move_id
      LIMIT 1`,
    [releaseId],
  );
  const moveId = move.rows[0]?.id;
  if (moveId === undefined) throw new Error("Phase 7 test fixture requires a damaging move");

  const speciesSlugs = [
    ...new Set(
      ZHOULIA_TYPED_CONTENT_V1.areas.flatMap((area) =>
        area.encounterPools.flatMap((pool) =>
          pool.entries.map((entry) => entry.speciesKey.replace("pokemon.species.", "")),
        ),
      ),
    ),
  ].sort();

  for (const slug of speciesSlugs) {
    let speciesId = (
      await client.query<{ id: string }>("SELECT id FROM pokemon_species WHERE slug=$1", [slug])
    ).rows[0]?.id;

    if (speciesId === undefined) {
      const nextDex = await client.query<{ national_dex: number }>(
        "SELECT COALESCE(MAX(national_dex),0)::int + 1 AS national_dex FROM pokemon_species",
      );
      speciesId = randomUUID();
      await client.query("INSERT INTO pokemon_species(id,national_dex,slug) VALUES ($1,$2,$3)", [
        speciesId,
        nextDex.rows[0]?.national_dex ?? 1,
        slug,
      ]);
    }

    await client.query(
      `INSERT INTO pokemon_species_revisions(
         id,content_release_id,species_id,display_name,catch_rate,base_exp,active,data
       ) VALUES ($1,$2,$3,$4,100,50,TRUE,'{}'::jsonb)
       ON CONFLICT (content_release_id,species_id)
       DO UPDATE SET active=TRUE`,
      [randomUUID(), releaseId, speciesId, slug],
    );

    let formId = (
      await client.query<{ id: string }>(
        "SELECT id FROM pokemon_forms WHERE species_id=$1 AND slug='default'",
        [speciesId],
      )
    ).rows[0]?.id;
    if (formId === undefined) {
      formId = randomUUID();
      await client.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES ($1,$2,'default')", [
        formId,
        speciesId,
      ]);
    }

    await client.query(
      `INSERT INTO pokemon_form_revisions(
         id,content_release_id,form_id,display_name,type1_id,type2_id,
         base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed,active,data
       ) VALUES ($1,$2,$3,$4,$5,NULL,40,40,40,40,40,40,TRUE,'{}'::jsonb)
       ON CONFLICT (content_release_id,form_id)
       DO UPDATE SET active=TRUE`,
      [randomUUID(), releaseId, formId, slug, typeId],
    );

    await client.query(
      `INSERT INTO pokemon_form_ability_options(
         id,content_release_id,form_id,ability_id,slot_kind,active
       ) VALUES ($1,$2,$3,$4,'PRIMARY',TRUE)
       ON CONFLICT (content_release_id,form_id,ability_id,slot_kind)
       DO UPDATE SET active=TRUE`,
      [randomUUID(), releaseId, formId, abilityId],
    );

    const learnset = await client.query<{ id: string }>(
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
    if (learnset.rows[0] === undefined) {
      await client.query(
        `INSERT INTO move_learnset_entries(
           id,content_release_id,form_id,move_id,learn_method,learn_level,source_key,active
         ) VALUES ($1,$2,$3,$4,'START',NULL,'phase7-test-only-zhoulia-fixture',TRUE)`,
        [randomUUID(), releaseId, formId, moveId],
      );
    } else {
      await client.query("UPDATE move_learnset_entries SET active=TRUE WHERE id=$1", [
        learnset.rows[0].id,
      ]);
    }
  }
}

async function loadPhase7LegacyStarterFixture(
  pool: Pool,
  releaseId: string,
): Promise<readonly ZhouliaStarterOptionInput[]> {
  // Phase 5 is a legacy architecture fixture. Reusing its starter rows here keeps
  // the historical phase-chain proof deterministic; it is NOT Bell product policy.
  const result = await pool.query<{ form_id: string; starter_level: number }>(
    `SELECT option.form_id, option.starter_level::int
       FROM starter_options option
      WHERE option.content_release_id=$1
        AND option.active=TRUE
      ORDER BY option.sort_order, option.form_id`,
    [releaseId],
  );
  if (result.rows.length === 0) {
    throw new Error("Phase 7 legacy starter fixture is empty");
  }
  return result.rows.map((row, sortOrder) => ({
    formId: row.form_id,
    starterLevel: row.starter_level,
    sortOrder,
  }));
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
        "SELECT id FROM content_releases WHERE release_no=$1",
        [RELEASE_NO.toString()],
      );
      if (existing.rows[0] !== undefined) return resolveRelease(client);

      const parent = await activeRelease(client);
      if (parent.releaseNo !== EXPECTED_PARENT_RELEASE_NO) {
        throw new Error(
          `Phase 7 seed expects ACTIVE release ${EXPECTED_PARENT_RELEASE_NO}, got ${parent.releaseNo}`,
        );
      }
      const newReleaseId = randomUUID();
      unwrap(
        "clone Phase 6 release",
        await catalog.clonePublishedRelease({
          parentReleaseId: parent.id,
          newReleaseId,
          releaseNo: RELEASE_NO,
          name: RELEASE_NAME,
        }),
      );
      return resolveRelease(client);
    });

    if (release.parentReleaseNo !== EXPECTED_PARENT_RELEASE_NO) {
      throw new Error(
        `Phase 7 release has unexpected parent release ${String(release.parentReleaseNo)}`,
      );
    }

    if (release.status === "DRAFT") {
      const fixtureClient = await pool.connect();
      try {
        await fixtureClient.query("BEGIN");
        await ensureTestOnlyZhouliaSpeciesFixture(fixtureClient, release.id);
        await fixtureClient.query("COMMIT");
      } catch (error) {
        await fixtureClient.query("ROLLBACK");
        throw error;
      } finally {
        fixtureClient.release();
      }

      const starterFixture = await loadPhase7LegacyStarterFixture(pool, release.id);
      await reconcileZhouliaExclusiveRelease(pool, {
        releaseId: release.id,
        starterOptions: starterFixture,
      });
      unwrap("validate Phase 7 Zhoulia release", await catalog.validateRelease(release.id));
      release = await withTransaction(pool, resolveRelease);
    }

    if (release.status === "VALIDATED") {
      unwrap("publish Phase 7 Zhoulia release", await catalog.publishRelease(release.id));
      release = await withTransaction(pool, resolveRelease);
    }
    if (release.status !== "PUBLISHED") {
      throw new Error(`Unexpected Phase 7 status: ${release.status}`);
    }

    unwrap("activate Phase 7 Zhoulia release", await catalog.activateRelease(release.id));
    const exclusive = await assertZhouliaExclusiveRelease(pool, { releaseId: release.id });

    console.log(
      `Phase 7 Zhoulia world slice ready: release ${release.id}, ` +
        `${exclusive.activeAreaSlugs.length} areas, ` +
        `${exclusive.activeConnectionKeys.length} connections, ` +
        `${exclusive.activeEncounterTables.length} encounter tables`,
    );
  } finally {
    await pool.end();
  }
}

await main();
