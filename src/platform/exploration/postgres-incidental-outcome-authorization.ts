import type { Pool } from "pg";
import type { IncidentalOutcomeAuthorization } from "../../modules/exploration/expedition-incidental-capture-action.js";

/**
 * Cross-check the outcome the bot actually committed for this trainer.
 * Caller still must load its original server-issued menu; this query alone
 * is not a ticket to fabricate menus, Ball IDs or CaptureService inputs.
 */
export class PostgresIncidentalOutcomeAuthorization implements IncidentalOutcomeAuthorization {
  public constructor(private readonly pool: Pool) {}

  public async belongsToPlayer(
    input: Parameters<IncidentalOutcomeAuthorization["belongsToPlayer"]>[0],
  ): Promise<boolean> {
    const response = await this.pool.query<{ authorized: boolean }>(
      `SELECT EXISTS (
        SELECT 1
        FROM solo_expedition_search_outcomes AS outcome
        JOIN solo_expeditions AS expedition
          ON expedition.id=outcome.expedition_id
         AND expedition.player_id=outcome.player_id
        JOIN encounters AS encounter
          ON encounter.id=outcome.encounter_id
         AND encounter.player_id=outcome.player_id
         AND encounter.area_id=expedition.area_id
        JOIN content_release_pointers pointer
          ON pointer.pointer_key='ACTIVE'
        JOIN content_releases release
          ON release.id=pointer.content_release_id
         AND release.status='PUBLISHED'
         AND encounter.content_release_id=release.id
        WHERE outcome.id=$1
          AND outcome.player_id=$2
          AND outcome.encounter_id=$3
          AND outcome.kind='INCIDENTAL'
          AND expedition.phase='ACTIVE'
      ) AS authorized`,
      [input.outcomeId, input.playerId, input.encounterId],
    );
    return response.rows[0]?.authorized === true;
  }
}
