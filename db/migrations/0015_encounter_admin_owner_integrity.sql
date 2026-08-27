-- 0015_encounter_admin_owner_integrity.sql
-- Phase 12C: durable, append-only replay evidence for safe Encounter administrative closure.

CREATE TABLE encounter_admin_operation_claims (
  id UUID PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  player_id UUID NOT NULL REFERENCES players(id),
  encounter_id UUID NOT NULL REFERENCES encounters(id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  before_data JSONB NOT NULL CHECK (jsonb_typeof(before_data) = 'object'),
  after_data JSONB NOT NULL CHECK (jsonb_typeof(after_data) = 'object'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_encounter_admin_claims_encounter_created
  ON encounter_admin_operation_claims(encounter_id, created_at DESC);

CREATE INDEX idx_encounter_admin_claims_player_created
  ON encounter_admin_operation_claims(player_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_encounter_admin_operation_claim_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'encounter admin operation claims are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_encounter_admin_operation_claim_immutable
BEFORE UPDATE OR DELETE ON encounter_admin_operation_claims
FOR EACH ROW EXECUTE FUNCTION guard_encounter_admin_operation_claim_immutable();
