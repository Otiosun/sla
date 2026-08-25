-- 0003_catalog_release_lifecycle.sql
-- Phase 4: explicit catalog/ruleset lifecycle, versioned learnsets/evolutions,
-- immutable validated/published snapshots, and an atomic active-release pointer.

ALTER TABLE rulesets
  DROP CONSTRAINT rulesets_status_check;

ALTER TABLE rulesets
  ADD CONSTRAINT rulesets_status_check
  CHECK (status IN ('DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED'));

ALTER TABLE rulesets
  ADD COLUMN validated_at TIMESTAMPTZ NULL,
  ADD COLUMN validation_report JSONB NULL CHECK (validation_report IS NULL OR jsonb_typeof(validation_report) = 'object'),
  ADD COLUMN config_fingerprint TEXT NULL CHECK (config_fingerprint IS NULL OR config_fingerprint ~ '^[0-9a-f]{64}$');

UPDATE rulesets
SET validated_at = COALESCE(validated_at, published_at, now()),
    validation_report = COALESCE(validation_report, '{"legacy_backfill":true}'::jsonb)
WHERE status IN ('PUBLISHED', 'ARCHIVED');

ALTER TABLE rulesets
  ADD CONSTRAINT rulesets_validated_timestamp_check
  CHECK (status = 'DRAFT' OR validated_at IS NOT NULL),
  ADD CONSTRAINT rulesets_published_timestamp_check
  CHECK (status NOT IN ('PUBLISHED', 'ARCHIVED') OR published_at IS NOT NULL);

ALTER TABLE content_releases
  DROP CONSTRAINT content_releases_status_check;

ALTER TABLE content_releases
  ADD CONSTRAINT content_releases_status_check
  CHECK (status IN ('DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED'));

ALTER TABLE content_releases
  ADD COLUMN validated_at TIMESTAMPTZ NULL,
  ADD COLUMN validation_report JSONB NULL CHECK (validation_report IS NULL OR jsonb_typeof(validation_report) = 'object'),
  ADD COLUMN content_fingerprint TEXT NULL CHECK (content_fingerprint IS NULL OR content_fingerprint ~ '^[0-9a-f]{64}$');

UPDATE content_releases
SET validated_at = COALESCE(validated_at, published_at, now()),
    validation_report = COALESCE(validation_report, '{"legacy_backfill":true}'::jsonb)
WHERE status IN ('PUBLISHED', 'ARCHIVED');

ALTER TABLE content_releases
  ADD CONSTRAINT content_releases_validated_timestamp_check
  CHECK (status = 'DRAFT' OR validated_at IS NOT NULL),
  ADD CONSTRAINT content_releases_published_timestamp_check
  CHECK (status NOT IN ('PUBLISHED', 'ARCHIVED') OR published_at IS NOT NULL);

CREATE TABLE pokemon_form_ability_options (
  id UUID PRIMARY KEY,
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  form_id UUID NOT NULL REFERENCES pokemon_forms(id),
  ability_id UUID NOT NULL REFERENCES abilities(id),
  slot_kind TEXT NOT NULL CHECK (slot_kind IN ('PRIMARY', 'SECONDARY', 'HIDDEN')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (content_release_id, form_id, ability_id, slot_kind)
);

CREATE INDEX idx_form_ability_release_form
  ON pokemon_form_ability_options(content_release_id, form_id);

CREATE TABLE move_learnset_entries (
  id UUID PRIMARY KEY,
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  form_id UUID NOT NULL REFERENCES pokemon_forms(id),
  move_id UUID NOT NULL REFERENCES moves(id),
  learn_method TEXT NOT NULL CHECK (learn_method IN ('LEVEL', 'START', 'TM', 'TUTOR', 'EVENT')),
  learn_level SMALLINT NULL CHECK (learn_level IS NULL OR learn_level >= 1),
  source_key TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (content_release_id, form_id, move_id, learn_method, learn_level),
  CHECK ((learn_method = 'LEVEL' AND learn_level IS NOT NULL) OR learn_method <> 'LEVEL')
);

CREATE INDEX idx_learnset_release_form
  ON move_learnset_entries(content_release_id, form_id, learn_method, learn_level);

CREATE TABLE evolution_rules (
  id UUID PRIMARY KEY,
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  from_form_id UUID NOT NULL REFERENCES pokemon_forms(id),
  to_form_id UUID NOT NULL REFERENCES pokemon_forms(id),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('LEVEL', 'ITEM', 'CONDITION')),
  trigger_config JSONB NOT NULL CHECK (jsonb_typeof(trigger_config) = 'object'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (content_release_id, from_form_id, to_form_id, trigger_kind),
  CHECK (from_form_id <> to_form_id)
);

CREATE INDEX idx_evolution_rules_release_from
  ON evolution_rules(content_release_id, from_form_id);

CREATE TABLE content_release_pointers (
  pointer_key TEXT PRIMARY KEY CHECK (pointer_key IN ('ACTIVE')),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION guard_release_child_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_release_id UUID;
  target_status TEXT;
BEGIN
  target_release_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.content_release_id ELSE NEW.content_release_id END;

  SELECT status INTO target_status
  FROM content_releases
  WHERE id = target_release_id;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'content release % does not exist', target_release_id USING ERRCODE = '23503';
  END IF;

  IF target_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'content release % is immutable in status %', target_release_id, target_status
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION guard_encounter_entry_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_revision_id UUID;
  target_status TEXT;
BEGIN
  target_revision_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.encounter_table_revision_id ELSE NEW.encounter_table_revision_id END;

  SELECT cr.status INTO target_status
  FROM encounter_table_revisions etr
  JOIN content_releases cr ON cr.id = etr.content_release_id
  WHERE etr.id = target_revision_id;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'encounter table revision % does not exist', target_revision_id USING ERRCODE = '23503';
  END IF;

  IF target_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'encounter entries are immutable when release status is %', target_status
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION guard_ruleset_child_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_ruleset_id UUID;
  target_status TEXT;
BEGIN
  target_ruleset_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.ruleset_id ELSE NEW.ruleset_id END;

  SELECT status INTO target_status
  FROM rulesets
  WHERE id = target_ruleset_id;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'ruleset % does not exist', target_ruleset_id USING ERRCODE = '23503';
  END IF;

  IF target_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'ruleset % is immutable in status %', target_ruleset_id, target_status
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION guard_ruleset_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'validated/published rulesets cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT', 'VALIDATED') THEN
      RAISE EXCEPTION 'invalid ruleset transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'VALIDATED' THEN
    IF NEW.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'invalid ruleset transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
    IF NEW.key IS DISTINCT FROM OLD.key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.engine_contract_version IS DISTINCT FROM OLD.engine_contract_version
       OR NEW.config IS DISTINCT FROM OLD.config
       OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
       OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
       OR NEW.config_fingerprint IS DISTINCT FROM OLD.config_fingerprint THEN
      RAISE EXCEPTION 'validated ruleset content is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'PUBLISHED' THEN
    IF NEW.status <> 'ARCHIVED' THEN
      RAISE EXCEPTION 'invalid ruleset transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM content_releases
      WHERE default_ruleset_id = OLD.id AND status IN ('VALIDATED', 'PUBLISHED')
    ) THEN
      RAISE EXCEPTION 'ruleset is still referenced by a validated/published release' USING ERRCODE = '55000';
    END IF;
    IF NEW.key IS DISTINCT FROM OLD.key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.engine_contract_version IS DISTINCT FROM OLD.engine_contract_version
       OR NEW.config IS DISTINCT FROM OLD.config
       OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
       OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
       OR NEW.config_fingerprint IS DISTINCT FROM OLD.config_fingerprint
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'published ruleset content is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'archived rulesets are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_content_release_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'validated/published content releases cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT', 'VALIDATED') THEN
      RAISE EXCEPTION 'invalid content release transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'VALIDATED' THEN
    IF NEW.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'invalid content release transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
    IF NEW.release_no IS DISTINCT FROM OLD.release_no
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.parent_release_id IS DISTINCT FROM OLD.parent_release_id
       OR NEW.default_ruleset_id IS DISTINCT FROM OLD.default_ruleset_id
       OR NEW.created_by_admin_principal_id IS DISTINCT FROM OLD.created_by_admin_principal_id
       OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
       OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
       OR NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint THEN
      RAISE EXCEPTION 'validated content release is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'PUBLISHED' THEN
    IF NEW.status <> 'ARCHIVED' THEN
      RAISE EXCEPTION 'invalid content release transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM content_release_pointers
      WHERE content_release_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'active content release cannot be archived' USING ERRCODE = '55000';
    END IF;
    IF NEW.release_no IS DISTINCT FROM OLD.release_no
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.parent_release_id IS DISTINCT FROM OLD.parent_release_id
       OR NEW.default_ruleset_id IS DISTINCT FROM OLD.default_ruleset_id
       OR NEW.created_by_admin_principal_id IS DISTINCT FROM OLD.created_by_admin_principal_id
       OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
       OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
       OR NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'published content release is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'archived content releases are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_active_release_pointer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_status TEXT;
BEGIN
  SELECT status INTO target_status
  FROM content_releases
  WHERE id = NEW.content_release_id;

  IF target_status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'active pointer may reference only a PUBLISHED release' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rulesets_lifecycle
BEFORE UPDATE OR DELETE ON rulesets
FOR EACH ROW EXECUTE FUNCTION guard_ruleset_lifecycle();

CREATE TRIGGER trg_content_releases_lifecycle
BEFORE UPDATE OR DELETE ON content_releases
FOR EACH ROW EXECUTE FUNCTION guard_content_release_lifecycle();

CREATE TRIGGER trg_type_matchups_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON type_matchups
FOR EACH ROW EXECUTE FUNCTION guard_ruleset_child_mutation();

CREATE TRIGGER trg_active_release_pointer
BEFORE INSERT OR UPDATE ON content_release_pointers
FOR EACH ROW EXECUTE FUNCTION guard_active_release_pointer();

CREATE TRIGGER trg_pokemon_type_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON pokemon_type_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_pokemon_species_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON pokemon_species_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_pokemon_form_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON pokemon_form_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_move_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON move_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_ability_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON ability_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_item_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON item_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_nature_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON nature_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_effect_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON effect_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_region_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON region_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_area_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON area_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_area_connection_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON area_connection_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_encounter_table_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON encounter_table_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_form_ability_options_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON pokemon_form_ability_options
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_move_learnset_entries_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON move_learnset_entries
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_evolution_rules_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON evolution_rules
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
CREATE TRIGGER trg_encounter_entries_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON encounter_entries
FOR EACH ROW EXECUTE FUNCTION guard_encounter_entry_mutation();
