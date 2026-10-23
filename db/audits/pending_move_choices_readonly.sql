-- Pokémon Beyond — diagnostic-only pending learning choices.
-- Run only with an approved read-only database role. Never share player or
-- instance IDs. This query returns aggregated totals, not personal records.
-- No migrations, writes, command executions or changes to Pokemon.
BEGIN TRANSACTION READ ONLY;

-- Pending learn decisions can be generated at different levels and remain
-- unresolved while the player continues to play. Detect duplicate requests,
-- already-known moves, and old/inactive pinned catalog revisions.
WITH choices AS (
  SELECT choice.id,
         choice.pokemon_instance_id,
         choice.move_id,
         choice.content_release_id,
         choice.learn_level,
         pokemon.status AS pokemon_status,
         EXISTS (
           SELECT 1
           FROM pokemon_move_slots slot
           WHERE slot.pokemon_instance_id = choice.pokemon_instance_id
             AND slot.move_id = choice.move_id
         ) AS already_known,
         EXISTS (
           SELECT 1
           FROM move_revisions revision
           WHERE revision.content_release_id = choice.content_release_id
             AND revision.move_id = choice.move_id
             AND revision.active = TRUE
         ) AS pinned_move_visible
  FROM pending_move_choices choice
  JOIN pokemon_instances pokemon ON pokemon.id = choice.pokemon_instance_id
  WHERE choice.status = 'PENDING'
),
repeated AS (
  SELECT pokemon_instance_id, move_id, count(*) AS total
  FROM choices
  GROUP BY pokemon_instance_id, move_id
  HAVING count(*) > 1
)
SELECT
  (SELECT count(*) FROM choices) AS pending_choices,
  (SELECT count(*) FROM choices WHERE pokemon_status <> 'ACTIVE')
    AS choices_for_non_active_pokemon,
  (SELECT count(*) FROM choices WHERE already_known)
    AS choices_for_already_known_moves,
  (SELECT count(*) FROM choices WHERE NOT pinned_move_visible)
    AS choices_without_active_pinned_move_revision,
  (SELECT count(*) FROM repeated) AS pokemon_move_pairs_with_repeated_choices,
  (SELECT coalesce(sum(total),0) FROM repeated)
    AS total_choices_in_repeated_pairs;

-- Historical overview, intentionally without any player or instance IDs.
SELECT choice.status,
       count(*) AS total
FROM pending_move_choices choice
GROUP BY choice.status
ORDER BY choice.status;

COMMIT;
