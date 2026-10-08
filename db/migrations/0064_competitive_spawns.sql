-- 0064_competitive_spawns.sql
-- Parallel Poketwo-style competitive spawn lifecycle.
-- This subsystem is group-scoped and intentionally does not create canonical Encounter rows.

CREATE TABLE competitive_spawns (
  id UUID PRIMARY KEY,
  community_group_id UUID NOT NULL REFERENCES community_groups(id),
  provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
  chat_ref TEXT NOT NULL CHECK (btrim(chat_ref) <> ''),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'WON', 'EXPIRED', 'CANCELLED')),
  outcome_kind TEXT NOT NULL DEFAULT 'POKEMON'
    CHECK (outcome_kind IN ('POKEMON', 'LOOT', 'EVENT', 'JACKPOT')),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  ruleset_id UUID NOT NULL REFERENCES rulesets(id),
  area_id UUID NULL REFERENCES areas(id),
  form_id UUID NULL REFERENCES pokemon_forms(id),
  species_id UUID NULL REFERENCES pokemon_species(id),
  species_display_name TEXT NULL,
  normalized_answers JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(normalized_answers) = 'array'),
  national_dex SMALLINT NULL CHECK (national_dex IS NULL OR national_dex > 0),
  level SMALLINT NULL CHECK (level IS NULL OR level BETWEEN 1 AND 100),
  shiny BOOLEAN NOT NULL DEFAULT FALSE,
  pokemon_snapshot JSONB NULL,
  render_spec JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(render_spec) = 'object'),
  creation_idempotency_key TEXT NOT NULL UNIQUE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  winner_player_id UUID NULL REFERENCES players(id),
  winning_inbox_message_id UUID NULL REFERENCES inbox_messages(id),
  resolved_at TIMESTAMPTZ NULL,
  CHECK (expires_at > opened_at),
  CHECK (
    (
      status = 'OPEN'
      AND winner_player_id IS NULL
      AND winning_inbox_message_id IS NULL
      AND resolved_at IS NULL
    )
    OR (
      status = 'WON'
      AND winner_player_id IS NOT NULL
      AND winning_inbox_message_id IS NOT NULL
      AND resolved_at IS NOT NULL
    )
    OR (
      status IN ('EXPIRED', 'CANCELLED')
      AND winner_player_id IS NULL
      AND winning_inbox_message_id IS NULL
      AND resolved_at IS NOT NULL
    )
  ),
  CHECK (
    outcome_kind <> 'POKEMON'
    OR (
      form_id IS NOT NULL
      AND species_id IS NOT NULL
      AND species_display_name IS NOT NULL
      AND national_dex IS NOT NULL
      AND level IS NOT NULL
      AND pokemon_snapshot IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX uq_competitive_spawns_one_open_per_group
  ON competitive_spawns(community_group_id)
  WHERE status = 'OPEN';

CREATE INDEX idx_competitive_spawns_group_recent
  ON competitive_spawns(community_group_id, opened_at DESC);

CREATE INDEX idx_competitive_spawns_expiry
  ON competitive_spawns(status, expires_at)
  WHERE status = 'OPEN';

CREATE TABLE competitive_spawn_attempts (
  id UUID PRIMARY KEY,
  spawn_id UUID NOT NULL REFERENCES competitive_spawns(id),
  inbox_message_id UUID NOT NULL REFERENCES inbox_messages(id),
  player_id UUID NOT NULL REFERENCES players(id),
  sender_ref TEXT NOT NULL CHECK (btrim(sender_ref) <> ''),
  normalized_guess TEXT NOT NULL CHECK (btrim(normalized_guess) <> ''),
  correct BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inbox_message_id)
);

CREATE INDEX idx_competitive_spawn_attempts_spawn_created
  ON competitive_spawn_attempts(spawn_id, created_at);

CREATE TABLE competitive_spawn_grants (
  id UUID PRIMARY KEY,
  spawn_id UUID NOT NULL UNIQUE REFERENCES competitive_spawns(id),
  player_id UUID NOT NULL REFERENCES players(id),
  pokemon_instance_id UUID NOT NULL UNIQUE REFERENCES pokemon_instances(id),
  placement_kind TEXT NOT NULL CHECK (placement_kind IN ('TEAM', 'BOX')),
  box_no INTEGER NULL CHECK (box_no IS NULL OR box_no > 0),
  slot_no INTEGER NOT NULL CHECK (slot_no > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (placement_kind = 'TEAM' AND box_no IS NULL AND slot_no BETWEEN 1 AND 6)
    OR
    (placement_kind = 'BOX' AND box_no IS NOT NULL)
  )
);

COMMENT ON TABLE competitive_spawns IS
  'Group-scoped mystery spawns. Independent from canonical per-player Encounter/Battle state.';

COMMENT ON TABLE competitive_spawn_grants IS
  'Exactly-once winner grants for competitive mystery spawns.';
