import type { Pool, PoolClient } from "pg";
import type { PublishedExplorationAreas } from "../../modules/exploration/expedition-world-admission.js";
import { withTransaction } from "../db/transaction.js";

interface AreaIdRow {
  readonly area_id: string;
}

/**
 * Read-only view of the *currently published* encounter content. Unlike a
 * catalog draft, an eligible area has an active world revision, an active
 * encounter table and at least one active entry referencing an active form
 * and species revision, all pinned to the same ACTIVE release.
 *
 * This checks structural coverage, not a specific hour, surface, weather or
 * player's encounter unlocks. It is a preview, never write authorization.
 */
export async function publishedExplorationAreasInTransaction(
  client: PoolClient,
  expectedContentReleaseId: string,
  lockActivePointer = false,
): Promise<PublishedExplorationAreas | null> {
  const release = await client.query<{ content_release_id: string }>(
    `SELECT release.id::text AS content_release_id
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id=pointer.content_release_id
       JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
      WHERE pointer.pointer_key='ACTIVE'
        AND release.status='PUBLISHED'
        AND ruleset.status='PUBLISHED'
        AND release.id::text=$1
      ${lockActivePointer ? "FOR SHARE OF pointer" : ""}`,
    [expectedContentReleaseId],
  );
  const current = release.rows[0]?.content_release_id;
  if (current === undefined) return null;

  const areas = await client.query<AreaIdRow>(
    `SELECT DISTINCT area.id::text AS area_id
       FROM areas area
       JOIN regions region ON region.id=area.region_id
       JOIN region_revisions region_revision
         ON region_revision.region_id=region.id
        AND region_revision.content_release_id=$1::uuid
        AND region_revision.active=TRUE
       JOIN area_revisions area_revision
         ON area_revision.area_id=area.id
        AND area_revision.content_release_id=$1::uuid
        AND area_revision.active=TRUE
       JOIN encounter_tables encounter_table
         ON encounter_table.area_id=area.id
       JOIN encounter_table_revisions table_revision
         ON table_revision.encounter_table_id=encounter_table.id
        AND table_revision.content_release_id=$1::uuid
        AND table_revision.active=TRUE
       JOIN encounter_entries entry
         ON entry.encounter_table_revision_id=table_revision.id
        AND entry.active=TRUE
       JOIN pokemon_forms form ON form.id=entry.form_id
       JOIN pokemon_form_revisions form_revision
         ON form_revision.form_id=form.id
        AND form_revision.content_release_id=$1::uuid
        AND form_revision.active=TRUE
       JOIN pokemon_species_revisions species_revision
         ON species_revision.species_id=form.species_id
        AND species_revision.content_release_id=$1::uuid
        AND species_revision.active=TRUE
      WHERE region.slug='zhoulia'
        AND area.slug IN ('vila-dos-arrozais', 'campos-de-yun')
      ORDER BY area_id`,
    [current],
  );
  return {
    contentReleaseId: current,
    encounterReadyAreaIds: areas.rows.map((row) => row.area_id),
  };
}

export class PostgresPublishedExplorationAreas {
  public constructor(private readonly pool: Pool) {}

  public async forActiveRelease(
    expectedContentReleaseId: string,
  ): Promise<PublishedExplorationAreas | null> {
    return withTransaction(
      this.pool,
      (client) => publishedExplorationAreasInTransaction(client, expectedContentReleaseId),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
