-- 0068_competitive_spawn_guess_guard.sql
-- Mechanical anti-bruteforce only. It does not try to infer whether normal chat is "spam".

CREATE TABLE competitive_spawn_guess_budgets (
  spawn_id UUID NOT NULL REFERENCES competitive_spawns(id),
  player_id UUID NOT NULL REFERENCES players(id),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  last_accepted_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (spawn_id, player_id)
);

CREATE INDEX idx_competitive_spawn_attempts_player_recent
  ON competitive_spawn_attempts(spawn_id, player_id, created_at DESC);

COMMENT ON TABLE competitive_spawn_guess_budgets IS
  'Per-player mechanical cadence/cap for explicit competitive identification commands.';
