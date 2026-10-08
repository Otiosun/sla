-- 0065_competitive_spawn_activity.sql
-- Durable adaptive activity meter for group-scoped competitive spawns.
-- Activity is observed passively before command/freeform routing so the feature never needs to
-- consume ordinary conversation just to measure it.

CREATE TABLE competitive_spawn_activity_state (
  community_group_id UUID PRIMARY KEY REFERENCES community_groups(id),
  progress_milli INTEGER NOT NULL DEFAULT 0 CHECK (progress_milli >= 0),
  target_roll INTEGER NULL CHECK (target_roll IS NULL OR target_roll BETWEEN 0 AND 9999),
  cycle_no BIGINT NOT NULL DEFAULT 0 CHECK (cycle_no >= 0),
  last_activity_at TIMESTAMPTZ NULL,
  last_player_id UUID NULL REFERENCES players(id),
  sender_streak INTEGER NOT NULL DEFAULT 0 CHECK (sender_streak >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE competitive_spawn_activity_senders (
  community_group_id UUID NOT NULL REFERENCES community_groups(id),
  player_id UUID NOT NULL REFERENCES players(id),
  sender_ref TEXT NOT NULL CHECK (btrim(sender_ref) <> ''),
  last_message_at TIMESTAMPTZ NOT NULL,
  last_fingerprint TEXT NULL,
  last_fingerprint_at TIMESTAMPTZ NULL,
  active_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_group_id, player_id)
);

CREATE INDEX idx_competitive_spawn_activity_senders_recent
  ON competitive_spawn_activity_senders(community_group_id, active_at DESC);

CREATE TABLE competitive_spawn_activity_receipts (
  provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
  external_message_id TEXT NOT NULL CHECK (btrim(external_message_id) <> ''),
  community_group_id UUID NOT NULL REFERENCES community_groups(id),
  player_id UUID NOT NULL REFERENCES players(id),
  sender_ref TEXT NOT NULL CHECK (btrim(sender_ref) <> ''),
  credited_milli INTEGER NOT NULL CHECK (credited_milli >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_message_id)
);

CREATE INDEX idx_competitive_spawn_activity_receipts_group_recent
  ON competitive_spawn_activity_receipts(community_group_id, occurred_at DESC);

COMMENT ON TABLE competitive_spawn_activity_state IS
  'Durable per-group progress toward the next competitive spawn. Values use milli-points to avoid floating point state.';

COMMENT ON TABLE competitive_spawn_activity_receipts IS
  'Append-only idempotency receipts for passive WhatsApp activity observation.';
