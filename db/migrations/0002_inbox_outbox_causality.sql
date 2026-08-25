-- 0002_inbox_outbox_causality.sql
-- Durable causality for external input and post-commit output.
-- 0001 is frozen; this migration only extends the existing inbox/outbox contract.

ALTER TABLE inbox_messages
  ADD COLUMN correlation_id UUID NULL;

UPDATE inbox_messages
SET correlation_id = gen_random_uuid()
WHERE correlation_id IS NULL;

ALTER TABLE inbox_messages
  ALTER COLUMN correlation_id SET NOT NULL;

ALTER TABLE outbox_messages
  ADD COLUMN correlation_id UUID NULL,
  ADD COLUMN causation_id UUID NULL;

UPDATE outbox_messages
SET correlation_id = gen_random_uuid()
WHERE correlation_id IS NULL;

ALTER TABLE outbox_messages
  ALTER COLUMN correlation_id SET NOT NULL;
