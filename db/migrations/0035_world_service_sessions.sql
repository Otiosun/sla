-- 0035_world_service_sessions.sql
-- Durable scene-proof metadata and restart-safe world-service visits.
-- Player prose is intentionally never persisted in this schema.

CREATE TABLE world_service_scene_proofs (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  area_id UUID NOT NULL REFERENCES areas(id),
  source_inbox_message_id UUID NOT NULL REFERENCES inbox_messages(id),
  line_count INTEGER NOT NULL CHECK (line_count >= 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ NULL,
  UNIQUE (source_inbox_message_id),
  UNIQUE (id, player_id, area_id),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX idx_world_service_scene_proofs_claim
  ON world_service_scene_proofs(player_id, area_id, created_at DESC, id DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE world_service_sessions (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  area_id UUID NOT NULL REFERENCES areas(id),
  service_kind TEXT NOT NULL CHECK (service_kind IN ('POKEMART', 'POKEMON_CENTER', 'PC')),
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  scene_proof_id UUID NULL,
  expected_reply_outbox_idempotency_key TEXT NULL CHECK (
    expected_reply_outbox_idempotency_key IS NULL
    OR char_length(expected_reply_outbox_idempotency_key) BETWEEN 1 AND 512
  ),
  expected_reply_external_message_id TEXT NULL CHECK (
    expected_reply_external_message_id IS NULL
    OR char_length(expected_reply_external_message_id) BETWEEN 1 AND 512
  ),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ NULL,
  FOREIGN KEY (scene_proof_id, player_id, area_id)
    REFERENCES world_service_scene_proofs(id, player_id, area_id),
  CHECK (service_kind = 'PC' OR scene_proof_id IS NOT NULL),
  CHECK (
    (expected_reply_outbox_idempotency_key IS NULL) =
    (expected_reply_external_message_id IS NULL)
  ),
  CHECK (
    (state = 'OPEN' AND closed_at IS NULL)
    OR (state = 'CLOSED' AND closed_at IS NOT NULL)
  ),
  CHECK (
    state = 'OPEN'
    OR (
      expected_reply_outbox_idempotency_key IS NULL
      AND expected_reply_external_message_id IS NULL
    )
  ),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_world_service_sessions_active_player
  ON world_service_sessions(player_id)
  WHERE closed_at IS NULL;

CREATE UNIQUE INDEX uq_world_service_sessions_scene_proof
  ON world_service_sessions(scene_proof_id)
  WHERE scene_proof_id IS NOT NULL;

CREATE INDEX idx_world_service_sessions_player_history
  ON world_service_sessions(player_id, created_at DESC);

COMMENT ON TABLE world_service_scene_proofs IS
  'Metadata-only evidence that a player supplied a four-or-more-line scene in an area. Raw prose is never stored here.';
COMMENT ON TABLE world_service_sessions IS
  'Durable facility session state. At most one open world-service session exists per player.';
