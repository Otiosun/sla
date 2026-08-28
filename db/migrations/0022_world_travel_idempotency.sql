-- 0022_world_travel_idempotency.sql
-- Phase 13.7/13.10: exactly-once world travel replay across Inbox crash/retry/restart.

CREATE TABLE world_travel_receipts (
  idempotency_key TEXT PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  destination_area_id UUID NOT NULL REFERENCES areas(id),
  expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
  resulting_revision BIGINT NOT NULL CHECK (resulting_revision = expected_revision + 1),
  result_snapshot JSONB NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_world_travel_receipts_player_created
  ON world_travel_receipts(player_id, created_at DESC);

COMMENT ON TABLE world_travel_receipts IS
  'Append-only exactly-once receipt for successful WorldService.travel calls. The scoped idempotency key is locked before mutation and the canonical from/to result is persisted in the same transaction.';
