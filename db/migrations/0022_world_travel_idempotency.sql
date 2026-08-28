-- 0022_world_travel_idempotency.sql
-- Phase 13.7/13.10: exactly-once world travel replay across Inbox crash/retry/restart.

CREATE TABLE world_travel_receipts (
  idempotency_key TEXT PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  from_area_id UUID NOT NULL REFERENCES areas(id),
  destination_area_id UUID NOT NULL REFERENCES areas(id),
  expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
  resulting_revision BIGINT NOT NULL CHECK (resulting_revision = expected_revision + 1),
  from_entered_at TIMESTAMPTZ NOT NULL,
  to_entered_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_area_id <> destination_area_id)
);

CREATE INDEX idx_world_travel_receipts_player_created
  ON world_travel_receipts(player_id, created_at DESC);

COMMENT ON TABLE world_travel_receipts IS
  'Append-only exactly-once evidence for successful WorldService.travel calls. The scoped idempotency key is transaction-locked before mutation; replay uses the pinned content release and transition evidence rather than rerunning mechanics.';
