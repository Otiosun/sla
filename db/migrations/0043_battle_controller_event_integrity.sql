CREATE INDEX battle_participant_controllers_battle_idx
  ON battle_participant_controllers(battle_id, participant_id);

CREATE UNIQUE INDEX battle_participant_controller_events_revision_unique
  ON battle_participant_controller_events(participant_id, resulting_revision);

CREATE FUNCTION guard_battle_participant_controller_event_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'battle participant controller events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER battle_participant_controller_event_immutable
BEFORE UPDATE OR DELETE ON battle_participant_controller_events
FOR EACH ROW EXECUTE FUNCTION guard_battle_participant_controller_event_immutable();

CREATE TRIGGER battle_participant_controller_event_no_truncate
BEFORE TRUNCATE ON battle_participant_controller_events
FOR EACH STATEMENT EXECUTE FUNCTION guard_battle_participant_controller_event_immutable();
