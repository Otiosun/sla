-- POKÉMON BEYOND — ACTIVE LEARNSET AUDIT (READ ONLY)
-- Run only with an approved read-only PostgreSQL role, against the intended
-- environment. No trainer identities, Pokemon instances or player data read.
-- The importer source pin is NOT proof that this active release uses it.
-- This file deliberately has no DDL, DML, procedures or temp tables.
BEGIN TRANSACTION READ ONLY;

-- A. Which exact content release and upstream source are ACTIVE?
-- Separate indexed counts avoid multiplying large catalog tables together.
SELECT release.id::text AS release_id,
       release.release_no,
       release.name AS release_name,
       release.status,
       (SELECT count(*) FROM pokemon_species_revisions species
         WHERE species.content_release_id = release.id AND species.active = TRUE
       ) AS active_species,
       (SELECT count(*) FROM pokemon_form_revisions form
         WHERE form.content_release_id = release.id AND form.active = TRUE
       ) AS active_forms,
       (SELECT count(*) FROM move_revisions move
         WHERE move.content_release_id = release.id AND move.active = TRUE
       ) AS active_moves,
       (SELECT count(*) FROM move_learnset_entries learnset
         WHERE learnset.content_release_id = release.id AND learnset.active = TRUE
       ) AS active_learnset_entries,
       (SELECT string_agg(DISTINCT species.data->>'sourceProvider', ', ')
        FROM pokemon_species_revisions species
        WHERE species.content_release_id = release.id AND species.active = TRUE
       ) AS species_source_providers,
       (SELECT string_agg(DISTINCT species.data->>'sourceCommit', ', ')
        FROM pokemon_species_revisions species
        WHERE species.content_release_id = release.id AND species.active = TRUE
       ) AS species_source_commits
FROM content_release_pointers pointer
JOIN content_releases release
  ON release.id = pointer.content_release_id
WHERE pointer.pointer_key = 'ACTIVE';

-- B. Coverage by active form, with START, LEVEL and other methods separated.
-- Forms without an executable early move are especially important.
WITH active_release AS (
  SELECT content_release_id
  FROM content_release_pointers
  WHERE pointer_key = 'ACTIVE'
),
coverage AS (
  SELECT species.national_dex,
         species.slug AS species_slug,
         form.slug AS form_slug,
         count(DISTINCT learnset.id) FILTER (
           WHERE learnset.learn_method = 'START' AND revision.active = TRUE
         ) AS start_moves,
         count(DISTINCT learnset.id) FILTER (
           WHERE learnset.learn_method = 'LEVEL' AND revision.active = TRUE
         ) AS level_moves,
         count(DISTINCT learnset.id) FILTER (
           WHERE learnset.learn_method = 'LEVEL'
             AND learnset.learn_level <= 10
             AND revision.active = TRUE
         ) AS level_moves_through_10,
         count(DISTINCT learnset.id) FILTER (
           WHERE learnset.learn_method IN ('TM', 'TUTOR', 'EVENT')
             AND revision.active = TRUE
         ) AS other_methods,
         min(learnset.learn_level) FILTER (
           WHERE learnset.learn_method = 'LEVEL' AND revision.active = TRUE
         ) AS first_level_move,
         max(learnset.learn_level) FILTER (
           WHERE learnset.learn_method = 'LEVEL' AND revision.active = TRUE
         ) AS last_level_move
  FROM active_release active
  JOIN pokemon_form_revisions form_revision
    ON form_revision.content_release_id = active.content_release_id
    AND form_revision.active = TRUE
  JOIN pokemon_forms form ON form.id = form_revision.form_id
  JOIN pokemon_species species ON species.id = form.species_id
  LEFT JOIN move_learnset_entries learnset
    ON learnset.content_release_id = active.content_release_id
    AND learnset.form_id = form.id
    AND learnset.active = TRUE
  LEFT JOIN move_revisions revision
    ON revision.content_release_id = active.content_release_id
    AND revision.move_id = learnset.move_id
  GROUP BY species.national_dex, species.slug, form.slug
)
SELECT *, CASE
  WHEN start_moves = 0 AND level_moves_through_10 = 0
    THEN 'REVIEW: NO EARLY EXECUTABLE START/LEVEL MOVES'
  WHEN level_moves = 0
    THEN 'REVIEW: NO LEVEL-UP MOVES'
  ELSE 'HAS LEVEL-UP DATA'
END AS audit_status
FROM coverage
ORDER BY (start_moves = 0 AND level_moves_through_10 = 0) DESC,
         (level_moves = 0) DESC, national_dex, form_slug;

-- C. Revisions sometimes combine multiple game/version groups.
-- This distinguishes a union of historical learnsets from one canonical game.
WITH active_release AS (
  SELECT content_release_id
  FROM content_release_pointers
  WHERE pointer_key = 'ACTIVE'
)
SELECT learnset.learn_method,
       count(*) AS entries,
       count(*) FILTER (
         WHERE learnset.source_key LIKE '%version-groups=%'
       ) AS tagged_with_version_groups,
       count(*) FILTER (
         WHERE learnset.source_key LIKE '%version-groups=%|%'
       ) AS tagged_with_multiple_versions,
       count(DISTINCT learnset.source_key) AS distinct_source_keys
FROM active_release active
JOIN move_learnset_entries learnset
  ON learnset.content_release_id = active.content_release_id
 AND learnset.active = TRUE
GROUP BY learnset.learn_method
ORDER BY learnset.learn_method;

-- D. Full legal level-up timetable per form.
-- Filter by a specific species_slug during review, if necessary.
WITH active_release AS (
  SELECT content_release_id
  FROM content_release_pointers
  WHERE pointer_key = 'ACTIVE'
)
SELECT species.national_dex,
       species.slug AS species_slug,
       form.slug AS form_slug,
       entry.learn_method,
       entry.learn_level,
       move.slug AS move_slug,
       revision.max_pp,
       entry.source_key
FROM active_release active
JOIN move_learnset_entries entry
  ON entry.content_release_id = active.content_release_id
 AND entry.active = TRUE
JOIN pokemon_forms form ON form.id = entry.form_id
JOIN pokemon_species species ON species.id = form.species_id
JOIN moves move ON move.id = entry.move_id
JOIN move_revisions revision
  ON revision.content_release_id = active.content_release_id
 AND revision.move_id = entry.move_id
 AND revision.active = TRUE
WHERE entry.learn_method IN ('START', 'LEVEL')
-- AND species.slug = 'your-target-species'
ORDER BY species.national_dex, form.slug,
         CASE entry.learn_method WHEN 'START' THEN 0 ELSE 1 END,
         entry.learn_level NULLS FIRST, move.slug;

COMMIT;
