import type { PoolClient } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";

interface FrozenOwner {
  readonly pokemon_instance_ids: readonly string[] | null;
}
interface ReadyMember {
  readonly pokemon_instance_id: string;
  readonly current_hp: number | null;
  readonly status: string | null;
  readonly form_id: string | null;
  readonly nature_id: string | null;
  readonly nature_revision_id: string | null;
  readonly ability_id: string | null;
  readonly ability_revision_id: string | null;
  readonly move_count: number;
  readonly published_move_count: number;
  readonly major_conditions: number;
}

/**
 * Conservative, read-only preflight for the *same frozen roster* consumed by
 * PostgresBattleRepository.loadInitializationData. This does not initialize
 * battle state and never grants a capability alone: private SENT menu proof,
 * Encounter CAS and canonical PvE initialization are mandatory afterward.
 *
 * Fail closed unless every frozen party member is fully loadable by the
 * canonical battle initialization and at least one member has HP > 0.
 * No "live TEAM" substitution for an absent encounter freeze.
 */
export async function readOfflineExpeditionBattleEligibility(
  client: Pick<PoolClient, "query">,
  input: {
    readonly playerId: PlayerId;
    readonly encounterId: string;
    readonly contentReleaseId: string;
  },
): Promise<boolean> {
  const frozen = await client.query<FrozenOwner>(
    `SELECT member.pokemon_instance_ids
     FROM encounter_players member
     JOIN encounters encounter
       ON encounter.id=member.encounter_id
      AND encounter.player_id=member.player_id
      AND encounter.status='ENGAGED'
      AND encounter.content_release_id=$3
     WHERE member.player_id=$1
       AND member.encounter_id=$2
       AND member.active=TRUE
     LIMIT 2`,
    [input.playerId, input.encounterId, input.contentReleaseId],
  );
  if (frozen.rows.length !== 1) return false;
  const ids = frozen.rows[0]?.pokemon_instance_ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 6 ||
    ids.some((id) => !/^[a-f0-9-]{36}$/iu.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    return false;
  }

  const team = await client.query<ReadyMember>(
    `SELECT frozen.id::text AS pokemon_instance_id,
            pokemon.current_hp,
            pokemon.status,
            form_revision.form_id::text AS form_id,
            training.nature_id::text AS nature_id,
            nature_revision.nature_id::text AS nature_revision_id,
            pokemon.ability_id::text AS ability_id,
            ability_revision.ability_id::text AS ability_revision_id,
            moves.move_count,
            moves.published_move_count,
            COALESCE(conditions.major_conditions,0)::int AS major_conditions
     FROM unnest($3::uuid[]) AS frozen(id)
     LEFT JOIN pokemon_instances pokemon
       ON pokemon.id=frozen.id AND pokemon.owner_player_id=$1
     LEFT JOIN pokemon_form_revisions form_revision
       ON form_revision.form_id=pokemon.form_id
      AND form_revision.content_release_id=$2
     LEFT JOIN pokemon_training_values training
       ON training.pokemon_instance_id=pokemon.id
     LEFT JOIN nature_revisions nature_revision
       ON nature_revision.nature_id=training.nature_id
      AND nature_revision.content_release_id=$2
     LEFT JOIN ability_revisions ability_revision
       ON ability_revision.ability_id=pokemon.ability_id
      AND ability_revision.content_release_id=$2
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS move_count,
              count(move_revision.move_id)::int AS published_move_count
       FROM pokemon_move_slots slot
       LEFT JOIN move_revisions move_revision
         ON move_revision.move_id=slot.move_id
        AND move_revision.content_release_id=$2
       WHERE slot.pokemon_instance_id=pokemon.id
     ) moves ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS major_conditions
       FROM pokemon_persistent_conditions condition
       WHERE condition.pokemon_instance_id=pokemon.id
         AND condition.condition_key IN ('BURN','POISON','PARALYSIS','SLEEP','FREEZE')
     ) conditions ON TRUE`,
    [input.playerId, input.contentReleaseId, ids],
  );
  return (
    team.rows.length === ids.length &&
    team.rows.every(
      (member) =>
        member.status === "ACTIVE" &&
        member.form_id !== null &&
        member.nature_id !== null &&
        member.nature_revision_id !== null &&
        member.ability_id !== null &&
        member.ability_revision_id !== null &&
        member.move_count >= 1 &&
        member.move_count <= 4 &&
        member.move_count === member.published_move_count &&
        member.major_conditions <= 1,
    ) &&
    team.rows.some((member) => member.current_hp !== null && member.current_hp > 0)
  );
}
