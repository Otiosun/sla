-- 0038_trainer_card_verification.sql
-- Durable, tamper-evident public verification records for officially issued Trainer Cards.
-- The signed public snapshot is immutable after issuance; revocation is a one-way tombstone.

CREATE TABLE trainer_card_verifications (
  public_id TEXT PRIMARY KEY
    CHECK (public_id ~ '^tcv_[A-Za-z0-9]{24}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  snapshot JSONB NOT NULL
    CHECK (jsonb_typeof(snapshot) = 'object'),
  signature TEXT NOT NULL
    CHECK (signature ~ '^[0-9a-f]{64}$'),
  signature_algorithm TEXT NOT NULL DEFAULT 'HMAC-SHA256'
    CHECK (signature_algorithm = 'HMAC-SHA256'),
  issued_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_at >= issued_at)
  )
);

CREATE INDEX idx_trainer_card_verifications_status
  ON trainer_card_verifications(status);

CREATE OR REPLACE FUNCTION enforce_trainer_card_verification_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trainer card verification tombstones cannot be deleted';
  END IF;

  IF NEW.public_id IS DISTINCT FROM OLD.public_id
    OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.signature IS DISTINCT FROM OLD.signature
    OR NEW.signature_algorithm IS DISTINCT FROM OLD.signature_algorithm
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'signed trainer card verification fields are immutable';
  END IF;

  IF OLD.status = 'ACTIVE'
    AND OLD.revoked_at IS NULL
    AND NEW.status = 'REVOKED'
    AND NEW.revoked_at IS NOT NULL
    AND NEW.revoked_at >= OLD.issued_at THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'trainer card verification status transition is not allowed';
END;
$$;

CREATE TRIGGER trg_trainer_card_verification_immutability
BEFORE UPDATE OR DELETE ON trainer_card_verifications
FOR EACH ROW
EXECUTE FUNCTION enforce_trainer_card_verification_immutability();

COMMENT ON TABLE trainer_card_verifications IS
  'Immutable signed public Trainer Card snapshots. ACTIVE records may transition once to REVOKED; revoked rows remain permanent verification tombstones.';
