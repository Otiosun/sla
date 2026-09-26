-- Human players on the same BattleSide still owe independent submissions.
ALTER TABLE battle_turn_window_required_players
  DROP CONSTRAINT battle_turn_window_required_players_side_unique;
