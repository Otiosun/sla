-- 0004_player_onboarding_starter.sql
-- Phase 5: pin onboarding to immutable content, version starter options, and harden state metadata.
-- Migrations 0001-0003 are frozen and intentionally untouched.

CREATE TABLE starter_options (
  id UUID PRIMARY KEY,
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  region_id UUID NOT NULL REFERENCES regions(id),
  form_id UUID NOT NULL REFERENCES pokemon_forms(id),
  starter_level SMALLINT NOT NULL DEFAULT 5 CHECK (starter_level BETWEEN 1 AND 100),
  sort_order SMALLINT NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (content_release_id, region_id, form_id)
);

CREATE INDEX idx_starter_options_release_region
  ON starter_options(content_release_id, region_id, active, sort_order, form_id);

CREATE TRIGGER trg_starter_options_release_guard
BEFORE INSERT OR UPDATE OR DELETE ON starter_options
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();

CREATE TABLE player_onboarding_context (
  player_id UUID PRIMARY KEY REFERENCES players(id),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  ruleset_id UUID NOT NULL REFERENCES rulesets(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (content_release_id IS NOT NULL AND ruleset_id IS NOT NULL)
);

ALTER TABLE onboarding_states
  ADD CONSTRAINT onboarding_completed_metadata_check
  CHECK (
    (state = 'COMPLETE' AND completed_at IS NOT NULL)
    OR (state <> 'COMPLETE' AND completed_at IS NULL)
  );

ALTER TABLE onboarding_states
  ADD CONSTRAINT onboarding_starter_claim_state_check
  CHECK (
    (state IN ('NEW', 'PROFILE_CREATED', 'REGION_SELECTED') AND starter_claim_key IS NULL)
    OR (state IN ('STARTER_PENDING', 'STARTER_GRANTED', 'COMPLETE') AND starter_claim_key IS NOT NULL)
  );

ALTER TABLE starter_grants
  ADD COLUMN content_release_id UUID NULL REFERENCES content_releases(id),
  ADD COLUMN ruleset_id UUID NULL REFERENCES rulesets(id),
  ADD COLUMN region_id UUID NULL REFERENCES regions(id),
  ADD COLUMN form_id UUID NULL REFERENCES pokemon_forms(id),
  ADD COLUMN correlation_id UUID NULL;

ALTER TABLE starter_grants
  ADD CONSTRAINT starter_grants_context_all_or_none_check
  CHECK (
    (content_release_id IS NULL AND ruleset_id IS NULL AND region_id IS NULL AND form_id IS NULL)
    OR
    (content_release_id IS NOT NULL AND ruleset_id IS NOT NULL AND region_id IS NOT NULL AND form_id IS NOT NULL)
  );

CREATE INDEX idx_starter_grants_release_region
  ON starter_grants(content_release_id, region_id)
  WHERE content_release_id IS NOT NULL;
