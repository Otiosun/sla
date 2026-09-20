import { Pool } from "pg";
import { gen123Id } from "../../db/imports/gen123/ids.js";
import { importGen123 } from "../../db/imports/gen123/import.js";
import { composeGen123MechanicsOverlay } from "../../db/imports/gen123/mechanics-overlay.js";
import { GEN123_SOURCE } from "../../db/imports/gen123/source.js";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { ZHOULIA_TYPED_CONTENT_V1 } from "../../src/modules/world/zhoulia-content.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import {
  assertZhouliaExclusiveRelease,
  reconcileZhouliaExclusiveRelease,
  type ZhouliaStarterOptionInput,
} from "../../src/platform/world/postgres-zhoulia-exclusive-release.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for simulator Gen I-III content preparation");
}
if (process.env.POKEAPI_DATA_DIR === undefined) {
  throw new Error("POKEAPI_DATA_DIR is required for simulator Gen I-III content preparation");
}

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly details?: Readonly<Record<string, unknown>>;
        };
      },
): T {
  if (result.ok) return result.value;
  throw new Error(
    `${label} failed [${result.error.code}]: ${result.error.message}; details=${JSON.stringify(
      result.error.details ?? {},
    )}`,
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 6 });
try {
  const activeBefore = await pool.query<{ content_release_id: string }>(
    "SELECT content_release_id FROM content_release_pointers WHERE pointer_key='ACTIVE'",
  );
  const activeBeforeId = activeBefore.rows[0]?.content_release_id;
  if (activeBeforeId === undefined)
    throw new Error("Simulator preparation requires an ACTIVE release");

  const starterRows = await pool.query<{
    species_slug: string;
    starter_level: number;
    sort_order: number;
  }>(
    `SELECT species.slug AS species_slug,
            option.starter_level::int,
            option.sort_order::int
     FROM starter_options option
     JOIN pokemon_forms form ON form.id=option.form_id
     JOIN pokemon_species species ON species.id=form.species_id
     WHERE option.content_release_id=$1 AND option.active=TRUE
     ORDER BY option.sort_order,species.slug`,
    [activeBeforeId],
  );
  if (starterRows.rows.length !== 3) {
    throw new Error(
      `Simulator UAT expects exactly 3 inherited starter fixtures before Gen I-III import; found ${starterRows.rows.length}`,
    );
  }
  const imported = await importGen123();
  if (imported.status !== "DRAFT") {
    throw new Error(`Fresh simulator Gen I-III import must be DRAFT; found ${imported.status}`);
  }

  const sourceReleaseId = imported.releaseId;
  const overlay = await composeGen123MechanicsOverlay(pool, {
    parentReleaseId: activeBeforeId,
    sourceReleaseId,
    targetReleaseId: gen123Id("release:zhoulia-gen123-mechanics-v1"),
    targetReleaseNo: 15002n,
    targetReleaseName: "Simulator - Zhoulia + Gen I-III Mechanics",
  });
  const releaseId = overlay.releaseId;

  const starters: ZhouliaStarterOptionInput[] = [];
  for (const starter of starterRows.rows) {
    const canonical = await pool.query<{ form_id: string }>(
      `SELECT form.id AS form_id
       FROM pokemon_species species
       JOIN pokemon_forms form
         ON form.species_id=species.id
        AND form.slug=species.slug
       JOIN pokemon_form_revisions revision
         ON revision.form_id=form.id
        AND revision.content_release_id=$1
        AND revision.active=TRUE
       WHERE species.slug=$2
       LIMIT 1`,
      [releaseId, starter.species_slug],
    );
    const formId = canonical.rows[0]?.form_id;
    if (formId === undefined) {
      throw new Error(
        `Gen I-III import did not provide the canonical form for starter fixture ${starter.species_slug}`,
      );
    }
    starters.push({
      formId,
      starterLevel: starter.starter_level,
      sortOrder: starter.sort_order,
    });
  }

  const release = await pool.query<{
    default_ruleset_id: string;
    ruleset_status: string;
    ruleset_key: string;
    config: unknown;
  }>(
    `SELECT release.default_ruleset_id,
            ruleset.status AS ruleset_status,
            ruleset.key AS ruleset_key,
            ruleset.config
     FROM content_releases release
     JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
     WHERE release.id=$1`,
    [releaseId],
  );
  const releaseRow = release.rows[0];
  if (releaseRow === undefined) throw new Error("Imported simulator release disappeared");
  if (releaseRow.ruleset_key !== "gen123-core") {
    throw new Error(`Simulator release is not pinned to gen123-core: ${releaseRow.ruleset_key}`);
  }
  if (
    releaseRow.config === null ||
    typeof releaseRow.config !== "object" ||
    !("progression" in releaseRow.config)
  ) {
    throw new Error("Gen I-III simulator ruleset lost the progression policy");
  }

  await reconcileZhouliaExclusiveRelease(pool, {
    releaseId,
    starterOptions: starters,
  });

  const catalog = new CatalogService(new PostgresCatalogRepository(pool));
  if (releaseRow.ruleset_status === "VALIDATED") {
    unwrap(
      "publish simulator Gen I-III ruleset",
      await catalog.publishRuleset(releaseRow.default_ruleset_id),
    );
  } else if (releaseRow.ruleset_status !== "PUBLISHED") {
    throw new Error(`Unexpected simulator Gen I-III ruleset status ${releaseRow.ruleset_status}`);
  }

  unwrap("validate simulator Zhoulia release", await catalog.validateRelease(releaseId));
  unwrap("publish simulator Zhoulia release", await catalog.publishRelease(releaseId));
  unwrap("activate simulator Zhoulia release", await catalog.activateRelease(releaseId));

  const exclusive = await assertZhouliaExclusiveRelease(pool, { releaseId });

  const fidelity = await pool.query<{
    total_species: number;
    sourced_species: number;
    generic_learnsets: number;
    type_matchups: number;
  }>(
    `WITH encounter_species AS (
       SELECT DISTINCT species.id
       FROM encounter_entries entry
       JOIN encounter_table_revisions table_revision
         ON table_revision.id=entry.encounter_table_revision_id
       JOIN pokemon_forms form ON form.id=entry.form_id
       JOIN pokemon_species species ON species.id=form.species_id
       WHERE table_revision.content_release_id=$1
         AND table_revision.active=TRUE
         AND entry.active=TRUE
     )
     SELECT
       (SELECT count(*)::int FROM encounter_species) AS total_species,
       (
         SELECT count(*)::int
         FROM encounter_species selected
         JOIN pokemon_species_revisions revision
           ON revision.species_id=selected.id
          AND revision.content_release_id=$1
          AND revision.active=TRUE
         WHERE revision.data->>'sourceProvider'=$2
           AND revision.data->>'sourceCommit'=$3
       ) AS sourced_species,
       (
         SELECT count(*)::int
         FROM move_learnset_entries
         WHERE content_release_id=$1
           AND active=TRUE
           AND source_key='phase7-test-only-zhoulia-fixture'
       ) AS generic_learnsets,
       (
         SELECT count(*)::int
         FROM type_matchups matchup
         JOIN content_releases release ON release.default_ruleset_id=matchup.ruleset_id
         WHERE release.id=$1
       ) AS type_matchups`,
    [releaseId, GEN123_SOURCE.provider, GEN123_SOURCE.commit],
  );
  const fidelityRow = fidelity.rows[0];
  if (fidelityRow === undefined) throw new Error("Simulator fidelity audit returned no row");
  if (fidelityRow.total_species < 1 || fidelityRow.sourced_species !== fidelityRow.total_species) {
    throw new Error(
      `Encounter species are not fully PokeAPI-backed: ${JSON.stringify(fidelityRow)}`,
    );
  }
  if (fidelityRow.generic_learnsets !== 0) {
    throw new Error(
      `Legacy generic wild learnsets leaked into Gen I-III simulator: ${fidelityRow.generic_learnsets}`,
    );
  }
  if (fidelityRow.type_matchups < 100) {
    throw new Error(`Simulator type chart is unexpectedly sparse: ${fidelityRow.type_matchups}`);
  }

  const invalidEncounterMoves = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM encounter_entries entry
     JOIN encounter_table_revisions table_revision
       ON table_revision.id=entry.encounter_table_revision_id
     JOIN move_learnset_entries learnset
       ON learnset.content_release_id=table_revision.content_release_id
      AND learnset.form_id=entry.form_id
      AND learnset.active=TRUE
     JOIN moves move ON move.id=learnset.move_id
     WHERE table_revision.content_release_id=$1
       AND table_revision.active=TRUE
       AND entry.active=TRUE
       AND move.slug='ember'
       AND NOT EXISTS (
         SELECT 1
         FROM pokemon_species species
         JOIN pokemon_forms form ON form.species_id=species.id
         WHERE form.id=entry.form_id
           AND species.slug IN ('charmander','charmeleon','charizard','vulpix','ninetales',
                                'growlithe','arcanine','ponyta','rapidash','magmar','cyndaquil',
                                'quilava','typhlosion','slugma','magcargo','houndour','houndoom',
                                'torchic','combusken','blaziken','numel','camerupt','torkoal')
       )`,
    [releaseId],
  );
  if ((invalidEncounterMoves.rows[0]?.count ?? 0) !== 0) {
    throw new Error(
      "Obviously incompatible inherited Ember learnsets remain in Zhoulia encounters",
    );
  }

  console.log(
    JSON.stringify({
      event: "sim.gen123-content.ready",
      releaseId,
      source: GEN123_SOURCE,
      activeRegions: ["zhoulia"],
      activeAreas: exclusive.activeAreaSlugs,
      activeConnections: exclusive.activeConnectionKeys,
      encounterTables: exclusive.activeEncounterTables.length,
      starterFixtures: exclusive.activeStarterCount,
      mechanicsOverlay: overlay.copied,
      fidelity: fidelityRow,
    }),
  );
} finally {
  await pool.end();
}
