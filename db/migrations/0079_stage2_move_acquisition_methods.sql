-- Stage 2: version-pinned move acquisition methods.
-- Historic START/LEVEL/TM/TUTOR/EVENT rows remain untouched.
-- New EVOLUTION/MACHINE/EGG rows are separate from XP-granted LEVEL moves.
ALTER TABLE move_learnset_entries
  DROP CONSTRAINT IF EXISTS move_learnset_entries_learn_method_check;

ALTER TABLE move_learnset_entries
  ADD CONSTRAINT move_learnset_entries_learn_method_check
  CHECK (learn_method IN ('LEVEL', 'START', 'TM', 'MACHINE', 'TUTOR', 'EVENT', 'EVOLUTION', 'EGG'));

-- Do not weaken the existing LEVEL requires a positive learn_level constraint.
-- The existing guard_release_child_mutation trigger still blocks mutation of
-- PUBLISHED and ARCHIVED release entries.
