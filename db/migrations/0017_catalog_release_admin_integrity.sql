-- 0017_catalog_release_admin_integrity.sql
-- Phase 12C / 12.23: durable exactly-once evidence for administrative
-- Content Release lifecycle transitions. Migrations 0001-0016 are immutable.

CREATE TABLE catalog_release_admin_operation_claims (
  id UUID PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('VALIDATE', 'PUBLISH')),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
  before_status TEXT NOT NULL CHECK (before_status IN ('DRAFT', 'VALIDATED')),
  after_status TEXT NOT NULL CHECK (after_status IN ('VALIDATED', 'PUBLISHED')),
  before_data JSONB NOT NULL CHECK (jsonb_typeof(before_data) = 'object'),
  after_data JSONB NOT NULL CHECK (jsonb_typeof(after_data) = 'object'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (operation_kind = 'VALIDATE' AND before_status = 'DRAFT' AND after_status = 'VALIDATED')
    OR
    (operation_kind = 'PUBLISH' AND before_status = 'VALIDATED' AND after_status = 'PUBLISHED')
  )
);

CREATE INDEX idx_catalog_release_admin_claims_release_created
  ON catalog_release_admin_operation_claims(content_release_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_catalog_release_admin_operation_claim_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'catalog release admin operation claims are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_catalog_release_admin_operation_claim_immutable
BEFORE UPDATE OR DELETE ON catalog_release_admin_operation_claims
FOR EACH ROW EXECUTE FUNCTION guard_catalog_release_admin_operation_claim_immutable();
