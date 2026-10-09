-- 0066_competitive_spawn_group_settings.sql
-- Competitive spawns are opt-in per configured RPG group. Missing row means disabled.

CREATE TABLE competitive_spawn_group_settings (
  community_group_id UUID PRIMARY KEY REFERENCES community_groups(id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE competitive_spawn_group_settings IS
  'Explicit per-group opt-in for competitive mystery spawns. Absence is disabled.';
