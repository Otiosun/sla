-- 0016_catalog_draft_admin_integrity.sql
-- Phase 12C / 12.22: optimistic concurrency, versioned reward definitions and
-- append-only replay evidence for administrative DRAFT catalog mutations.
-- Migrations 0001-0015 are immutable.

ALTER TABLE content_releases
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0);

-- Content release revisions are mutable only while the release is still DRAFT. Lifecycle
-- transitions themselves do not manufacture a content revision.
CREATE OR REPLACE FUNCTION guard_content_release_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1 THEN
      RAISE EXCEPTION 'draft content release revision must stay stable or advance exactly once'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'content release revision is immutable outside DRAFT content edits'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_content_release_revision
BEFORE UPDATE ON content_releases
FOR EACH ROW EXECUTE FUNCTION guard_content_release_revision();

-- Rewards are catalog content, not runtime reward claims. Stable identity is global while the
-- executable program is revisioned per content release like moves/items/effects.
CREATE TABLE reward_definitions (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE reward_revisions (
  id UUID PRIMARY KEY,
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  reward_id UUID NOT NULL REFERENCES reward_definitions(id),
  display_name TEXT NOT NULL,
  program JSONB NOT NULL CHECK (jsonb_typeof(program) = 'object'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (content_release_id, reward_id)
);

CREATE INDEX idx_reward_revisions_release
  ON reward_revisions(content_release_id, reward_id);

CREATE TRIGGER trg_reward_revisions_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON reward_revisions
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();

CREATE TABLE catalog_admin_operation_claims (
  id UUID PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'SPECIES', 'MOVE', 'ITEM', 'AREA', 'ENCOUNTER_TABLE', 'REWARD', 'EFFECT'
  )),
  resource_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  before_revision BIGINT NOT NULL CHECK (before_revision >= 0),
  after_revision BIGINT NOT NULL CHECK (after_revision = before_revision + 1),
  before_data JSONB NULL CHECK (before_data IS NULL OR jsonb_typeof(before_data) = 'object'),
  after_data JSONB NOT NULL CHECK (jsonb_typeof(after_data) = 'object'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_catalog_admin_claims_release_created
  ON catalog_admin_operation_claims(content_release_id, created_at DESC);
CREATE INDEX idx_catalog_admin_claims_resource_created
  ON catalog_admin_operation_claims(resource_kind, resource_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_catalog_admin_operation_claim_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'catalog admin operation claims are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_catalog_admin_operation_claim_immutable
BEFORE UPDATE OR DELETE ON catalog_admin_operation_claims
FOR EACH ROW EXECUTE FUNCTION guard_catalog_admin_operation_claim_immutable();
