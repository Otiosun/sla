-- 0040_trainer_card_ed25519_signature.sql
-- Remove shared-secret HMAC verification authority from public Trainer Card records.
-- Existing HMAC records cannot be safely converted without the original private signing authority,
-- so this migration fails closed if any legacy verification record exists.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM trainer_card_verifications) THEN
    RAISE EXCEPTION
      'cannot migrate trainer card verification records from HMAC-SHA256 to ED25519; legacy rows must be explicitly reissued';
  END IF;
END;
$$;

ALTER TABLE trainer_card_verifications
  DROP CONSTRAINT trainer_card_verifications_signature_check,
  DROP CONSTRAINT trainer_card_verifications_signature_algorithm_check;

ALTER TABLE trainer_card_verifications
  ALTER COLUMN signature_algorithm SET DEFAULT 'ED25519';

ALTER TABLE trainer_card_verifications
  ADD CONSTRAINT trainer_card_verifications_signature_check
    CHECK (signature ~ '^ed25519:[A-Za-z0-9_-]{86}$'),
  ADD CONSTRAINT trainer_card_verifications_signature_algorithm_check
    CHECK (signature_algorithm = 'ED25519');

COMMENT ON COLUMN trainer_card_verifications.signature_algorithm IS
  'Asymmetric signature algorithm. Public verification uses only the Ed25519 public key; private signing material is never required by the public runtime.';
