-- INERT CANDIDATE. No production migration or content defaults.
CREATE TABLE solo_expedition_search_targets (
  outcome_id UUID PRIMARY KEY REFERENCES solo_expedition_search_outcomes(id),
  species_slug TEXT NOT NULL CHECK (species_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);
CREATE TRIGGER solo_search_target_immutable BEFORE UPDATE OR DELETE
  ON solo_expedition_search_targets FOR EACH ROW EXECUTE FUNCTION reject_solo_incidental_menu_mutation();
