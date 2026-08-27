-- 0012_player360_read_model_indexes.sql
-- Phase 12B: stable Player 360 search/pagination indexes only.
-- Migrations 0001-0011 are immutable.

CREATE INDEX idx_players_created_id
  ON players(created_at DESC, id DESC);

CREATE INDEX idx_players_status_created_id
  ON players(status, created_at DESC, id DESC);

CREATE INDEX idx_player_profiles_trainer_name_lower_pattern
  ON player_profiles(lower(trainer_name) text_pattern_ops, player_id);

CREATE INDEX idx_player_profiles_origin_region_player
  ON player_profiles(origin_region_id, player_id)
  WHERE origin_region_id IS NOT NULL;
