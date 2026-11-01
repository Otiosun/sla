import type { PoolClient } from "pg";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

/**
 * Only fields proven by an actual canonical Encounter and the currently
 * ACTIVE/PUBLISHED content release. No generated species names, odds, balls,
 * shiny guesses, battle actions, grants, or user-submitted encounter IDs.
 */
export interface VerifiedExpeditionSearchEncounterPreview {
  readonly speciesName: string;
  readonly level: number;
  readonly shiny: boolean;
}

export async function readVerifiedExpeditionSearchEncounterPreview(
  client: PoolClient,
  input: {
    readonly playerId: string;
    readonly areaId: string;
    readonly outcomeId: string;
    readonly encounterId: string;
  },
): Promise<Result<VerifiedExpeditionSearchEncounterPreview>> {
  const found = await client.query<{
    readonly display_name: string;
    readonly level: string;
    readonly shiny: string;
  }>(
    `SELECT species.display_name,
            wild.pokemon_snapshot->>'level' AS level,
            wild.pokemon_snapshot->>'shiny' AS shiny
       FROM solo_expedition_search_outcomes outcome
       JOIN encounters encounter
         ON encounter.id=outcome.encounter_id
        AND encounter.player_id=outcome.player_id
        AND encounter.area_id=$3
        AND encounter.status IN ('CREATED','PRESENTED','ENGAGED')
       JOIN encounter_wild_snapshots wild
         ON wild.encounter_id=encounter.id
        AND wild.wild_no=1 AND wild.status='ACTIVE'
       JOIN content_release_pointers pointer
         ON pointer.pointer_key='ACTIVE'
       JOIN content_releases release
         ON release.id=pointer.content_release_id
        AND release.status='PUBLISHED'
        AND release.id=encounter.content_release_id
       JOIN rulesets ruleset
         ON ruleset.id=encounter.ruleset_id AND ruleset.status='PUBLISHED'
       JOIN pokemon_species_revisions species
         ON species.content_release_id=release.id AND species.active=TRUE
        AND species.species_id=(wild.pokemon_snapshot->>'speciesId')::uuid
      WHERE outcome.id=$1 AND outcome.player_id=$2
        AND outcome.encounter_id=$4
        AND outcome.kind IN ('INCIDENTAL','DIRECT')`,
    [input.outcomeId, input.playerId, input.areaId, input.encounterId],
  );
  if (found.rows.length !== 1) {
    return err(appError("FLOW_BLOCKED", "No published canonical encounter for this search"));
  }
  const row = found.rows[0]!;
  const level = Number(row.level);
  if (
    typeof row.display_name !== "string" ||
    row.display_name.trim() !== row.display_name ||
    row.display_name.length < 1 ||
    row.display_name.length > 70 ||
    /[\r\n*_~`<>\u031d]/u.test(row.display_name) ||
    row.display_name.includes("[Ler mais]") ||
    /\p{Cc}/u.test(row.display_name) ||
    !Number.isSafeInteger(level) ||
    level < 1 ||
    level > 100 ||
    (row.shiny !== "true" && row.shiny !== "false")
  ) {
    return err(appError("FLOW_BLOCKED", "Published encounter presentation is inconsistent"));
  }
  return ok({
    speciesName: row.display_name,
    level,
    shiny: row.shiny === "true",
  });
}
