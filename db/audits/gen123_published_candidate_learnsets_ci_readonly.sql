-- CI-only read-only audit of the published Gen I-III candidate, NOT ACTIVE.
-- A published candidate must stay separate from the currently active release.
BEGIN TRANSACTION READ ONLY;

WITH candidate AS (
  SELECT release.id
  FROM content_releases release
  WHERE release.status='PUBLISHED'
    AND release.validation_report #>> '{source,commit}' =
        '7af36d9f3424366ffc46e90d94c8bc120df39cd0'
),
forms AS (
  SELECT revision.form_id
  FROM pokemon_form_revisions revision
  JOIN candidate ON candidate.id=revision.content_release_id
  WHERE revision.active=TRUE
),
coverage AS (
  SELECT form.form_id,
         count(DISTINCT entry.move_id) FILTER (
           WHERE entry.learn_method='START' AND move.active=TRUE
         ) AS start_moves,
         count(DISTINCT entry.move_id) FILTER (
           WHERE entry.learn_method='LEVEL' AND move.active=TRUE
         ) AS level_moves,
         count(DISTINCT entry.move_id) FILTER (
           WHERE entry.learn_method='LEVEL' AND entry.learn_level <= 10
             AND move.active=TRUE
         ) AS early_level_moves
  FROM forms form
  CROSS JOIN candidate
  LEFT JOIN move_learnset_entries entry
    ON entry.content_release_id=candidate.id
   AND entry.form_id=form.form_id
   AND entry.active=TRUE
  LEFT JOIN move_revisions move
    ON move.content_release_id=candidate.id
   AND move.move_id=entry.move_id
  GROUP BY form.form_id
)
SELECT
  (SELECT count(*) FROM candidate) AS candidate_releases,
  (SELECT count(*) FROM pokemon_species_revisions species
    JOIN candidate ON candidate.id=species.content_release_id
    WHERE species.active=TRUE) AS candidate_species,
  (SELECT count(*) FROM forms) AS candidate_forms,
  (SELECT count(*) FROM move_learnset_entries entry
    JOIN candidate ON candidate.id=entry.content_release_id
    WHERE entry.active=TRUE) AS candidate_learnset_entries,
  count(*) FILTER (
    WHERE start_moves=0 AND early_level_moves=0
  ) AS forms_needing_early_move_review,
  count(*) FILTER (
    WHERE level_moves=0
  ) AS forms_with_no_level_up_moves,
  (SELECT count(*) FROM content_release_pointers pointer
    JOIN candidate ON candidate.id=pointer.content_release_id
    WHERE pointer.pointer_key='ACTIVE') AS candidate_active_pointers
FROM coverage;

COMMIT;
