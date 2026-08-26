-- 0006_encounter_lifecycle_integrity.sql
-- Phase 8: durable encounter creation idempotency, frozen expiration, and lifecycle metadata integrity.
-- Migrations 0001-0005 are frozen and intentionally untouched.

ALTER TABLE encounters
  ADD COLUMN creation_idempotency_key TEXT NULL,
  ADD COLUMN expires_at TIMESTAMPTZ NULL;

-- Existing rows predate service-level encounter creation idempotency. Give each one a stable,
-- collision-free legacy key without changing its identity or gameplay state.
UPDATE encounters
SET creation_idempotency_key = 'legacy:' || id::text
WHERE creation_idempotency_key IS NULL;

-- Compatibility boundary for older internal callers that still insert encounter rows directly.
-- New Phase 8 service callers always provide the hashed external idempotency key. A legacy caller
-- that omits it receives a stable per-encounter key rather than weakening the NOT NULL invariant.
CREATE OR REPLACE FUNCTION fill_legacy_encounter_creation_key()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.creation_idempotency_key IS NULL THEN
    NEW.creation_idempotency_key := 'legacy:' || NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_encounters_fill_legacy_creation_key
BEFORE INSERT ON encounters
FOR EACH ROW EXECUTE FUNCTION fill_legacy_encounter_creation_key();

ALTER TABLE encounters
  ALTER COLUMN creation_idempotency_key SET NOT NULL;

ALTER TABLE encounters
  ADD CONSTRAINT encounters_creation_idempotency_key_check
  CHECK (char_length(creation_idempotency_key) BETWEEN 1 AND 128),
  ADD CONSTRAINT encounters_expiration_check
  CHECK (expires_at IS NULL OR expires_at > created_at);

CREATE UNIQUE INDEX uq_encounters_player_creation_idempotency
  ON encounters(player_id, creation_idempotency_key);

CREATE INDEX idx_encounters_expiration_cleanup
  ON encounters(expires_at, id)
  WHERE expires_at IS NOT NULL AND status IN ('CREATED', 'PRESENTED', 'ENGAGED');

-- Terminal rows created before this migration may legitimately have no closed_at because 0001
-- did not enforce the relation. Preserve their historical update timestamp as the best known close.
UPDATE encounters
SET closed_at = updated_at
WHERE status IN ('CAPTURED', 'FLED', 'EXPIRED', 'CLOSED')
  AND closed_at IS NULL;

ALTER TABLE encounters
  ADD CONSTRAINT encounters_closed_state_check
  CHECK (
    (status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE') AND closed_at IS NULL)
    OR
    (status IN ('CAPTURED', 'FLED', 'EXPIRED', 'CLOSED') AND closed_at IS NOT NULL)
  );
