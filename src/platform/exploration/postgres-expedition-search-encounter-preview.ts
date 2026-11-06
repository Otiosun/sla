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
  return decodePreview(found.rows[0]!);
}

function decodePreview(row: {
  display_name: string;
  level: string;
  shiny: string;
}): Result<VerifiedExpeditionSearchEncounterPreview> {
  const level = Number(row.level);
  if (
    typeof row.display_name !== "string" ||
    row.display_name.trim() !== row.display_name ||
    row.display_name.length < 1 ||
    row.display_name.length > 70 ||
    /(?:[\r\n*_~`<>]|\u031d)/u.test(row.display_name) ||
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

/** Read the original wild snapshot from the release pinned by the committed encounter. */
export async function readCommittedExpeditionSearchEncounter(
  client: Pick<PoolClient, "query">,
  input: { playerId: string; areaId: string; outcomeId: string; encounterId: string },
): Promise<Result<{ preview: VerifiedExpeditionSearchEncounterPreview; actionable: boolean }>> {
  const found = await client.query<{
    display_name: string;
    level: string;
    shiny: string;
    actionable: boolean;
  }>(
    `SELECT species.display_name, frozen.pokemon_snapshot->>'level' AS level,
            frozen.pokemon_snapshot->>'shiny' AS shiny,
            COALESCE(pointer.content_release_id=release.id AND release.status='PUBLISHED'
              AND ruleset.status='PUBLISHED' AND encounter.status IN ('CREATED','PRESENTED','ENGAGED')
              AND (encounter.expires_at IS NULL OR encounter.expires_at>clock_timestamp())
              AND expedition.phase='ACTIVE' AND expedition.revision=outcome.expedition_revision+1
              AND expedition.area_id=encounter.area_id AND location.area_id=encounter.area_id
              AND wild.status='ACTIVE', false) AS actionable
       FROM solo_expedition_search_outcomes outcome
       JOIN encounters encounter ON encounter.id=outcome.encounter_id
         AND encounter.player_id=outcome.player_id AND encounter.area_id=$3
       JOIN encounter_snapshots frozen ON frozen.encounter_id=encounter.id
       JOIN content_releases release ON release.id=encounter.content_release_id
         AND release.status IN ('PUBLISHED','ARCHIVED')
       JOIN rulesets ruleset ON ruleset.id=encounter.ruleset_id
         AND ruleset.status IN ('PUBLISHED','ARCHIVED')
       JOIN pokemon_species_revisions species ON species.content_release_id=release.id AND species.active
         AND species.species_id::text=frozen.pokemon_snapshot->>'speciesId'
       JOIN solo_expeditions expedition ON expedition.id=outcome.expedition_id AND expedition.player_id=outcome.player_id
       LEFT JOIN content_release_pointers pointer ON pointer.pointer_key='ACTIVE'
       LEFT JOIN player_locations location ON location.player_id=outcome.player_id
       LEFT JOIN encounter_wild_snapshots wild ON wild.encounter_id=encounter.id AND wild.wild_no=1
       WHERE outcome.id=$1 AND outcome.player_id=$2 AND outcome.encounter_id=$4
         AND outcome.kind IN ('DIRECT','INCIDENTAL')`,
    [input.outcomeId, input.playerId, input.areaId, input.encounterId],
  );
  const row = found.rows[0];
  if (found.rows.length !== 1 || !row)
    return err(appError("FLOW_BLOCKED", "Não foi possível confirmar essa busca."));
  const preview = decodePreview(row);
  return preview.ok ? ok({ preview: preview.value, actionable: row.actionable }) : preview;
}
