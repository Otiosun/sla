-- 0020_messaging_recovery_integrity.sql
-- Phase 13A: durable normalized Inbox payloads and recoverable delivery claims.
-- Existing 0001/0002 messaging tables remain the canonical spine.

ALTER TABLE inbox_messages
  ADD COLUMN normalized_payload JSONB NULL
    CHECK (normalized_payload IS NULL OR jsonb_typeof(normalized_payload) = 'object'),
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN processing_started_at TIMESTAMPTZ NULL;

ALTER TABLE outbox_messages
  ADD COLUMN sending_started_at TIMESTAMPTZ NULL;

CREATE INDEX idx_inbox_processing_recovery
  ON inbox_messages(status, processing_started_at, received_at);

CREATE INDEX idx_outbox_sending_recovery
  ON outbox_messages(status, sending_started_at, created_at);

COMMENT ON COLUMN inbox_messages.normalized_payload IS
  'Provider-neutral IncomingMessage envelope. NULL is reserved for rows predating Phase 13.';
COMMENT ON COLUMN inbox_messages.processing_started_at IS
  'Time the current PROCESSING lease began; used to recover abandoned claims after restart.';
COMMENT ON COLUMN outbox_messages.sending_started_at IS
  'Time the current SENDING lease began; used to reclaim abandoned delivery attempts.';
