-- 0056_capture_turn_action.sql
-- Failed capture is a durable PVE TurnWindow action, reserved atomically before Ball consumption.

ALTER TABLE battle_turn_submissions
  DROP CONSTRAINT IF EXISTS battle_turn_submissions_action_type_check;

ALTER TABLE battle_turn_submissions
  ADD CONSTRAINT battle_turn_submissions_action_type_check
    CHECK (action_type IN ('USE_MOVE', 'SWITCH', 'USE_ITEM', 'CAPTURE_ATTEMPT', 'FLEE'));
