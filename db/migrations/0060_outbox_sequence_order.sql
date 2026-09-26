-- 0060_outbox_sequence_order.sql
-- Preserve the order declared by one handler result when multiple outbound messages share
-- the same transaction timestamp.

ALTER TABLE outbox_messages
  ADD COLUMN sequence_no INTEGER NOT NULL DEFAULT 0 CHECK (sequence_no >= 0);

CREATE INDEX idx_outbox_delivery_order
  ON outbox_messages(status, next_attempt_at, created_at, causation_id, sequence_no, id);
