-- 0008_capture_attempt_integrity.sql
-- Durable capture request binding, RNG reproducibility and lifecycle coherence.
-- Migrations 0001-0007 are immutable; this migration only extends capture_attempts.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM capture_attempts) THEN
    RAISE EXCEPTION
      'Cannot apply 0008 with legacy capture_attempts lacking request fingerprint and RNG evidence';
  END IF;
END
$$;

ALTER TABLE capture_attempts
  ADD COLUMN request_fingerprint TEXT NULL,
  ADD COLUMN source_encounter_status TEXT NULL,
  ADD COLUMN correlation_id UUID NULL,
  ADD COLUMN rng_seed_ciphertext BYTEA NULL,
  ADD COLUMN rng_seed_iv BYTEA NULL,
  ADD COLUMN rng_seed_auth_tag BYTEA NULL,
  ADD COLUMN rng_seed_key_version INTEGER NULL,
  ADD COLUMN rng_counter BIGINT NULL,
  ADD COLUMN breakdown JSONB NULL;

ALTER TABLE capture_attempts
  ALTER COLUMN request_fingerprint SET NOT NULL,
  ALTER COLUMN source_encounter_status SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL,
  ALTER COLUMN rng_seed_ciphertext SET NOT NULL,
  ALTER COLUMN rng_seed_iv SET NOT NULL,
  ALTER COLUMN rng_seed_auth_tag SET NOT NULL,
  ALTER COLUMN rng_seed_key_version SET NOT NULL,
  ALTER COLUMN rng_counter SET NOT NULL,
  ALTER COLUMN breakdown SET NOT NULL,
  ADD CONSTRAINT capture_attempts_request_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT capture_attempts_source_status
    CHECK (source_encounter_status IN ('ENGAGED', 'IN_BATTLE')),
  ADD CONSTRAINT capture_attempts_source_battle_coherent
    CHECK (
      (source_encounter_status = 'ENGAGED' AND battle_id IS NULL)
      OR (source_encounter_status = 'IN_BATTLE' AND battle_id IS NOT NULL)
    ),
  ADD CONSTRAINT capture_attempts_rng_envelope_shape
    CHECK (
      octet_length(rng_seed_ciphertext) = 32
      AND octet_length(rng_seed_iv) = 12
      AND octet_length(rng_seed_auth_tag) = 16
      AND rng_seed_key_version > 0
      AND rng_counter >= 1
    ),
  ADD CONSTRAINT capture_attempts_breakdown_object
    CHECK (jsonb_typeof(breakdown) = 'object'),
  ADD CONSTRAINT capture_attempts_lifecycle_coherent
    CHECK (
      (status = 'PENDING' AND pokemon_instance_id IS NULL AND resolved_at IS NULL)
      OR (status = 'FAILED' AND pokemon_instance_id IS NULL AND resolved_at IS NOT NULL)
      OR (status = 'CAPTURED' AND pokemon_instance_id IS NOT NULL AND resolved_at IS NOT NULL)
    );

CREATE INDEX idx_capture_attempts_encounter_created
  ON capture_attempts(encounter_id, created_at DESC);

CREATE INDEX idx_capture_attempts_correlation
  ON capture_attempts(correlation_id, created_at DESC);
