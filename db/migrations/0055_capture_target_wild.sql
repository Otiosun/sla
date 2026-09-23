ALTER TABLE capture_attempts
  ADD COLUMN target_wild_no SMALLINT NOT NULL DEFAULT 1
    CHECK (target_wild_no BETWEEN 1 AND 6);

ALTER TABLE capture_attempts
  ADD CONSTRAINT capture_attempts_target_wild_fk
  FOREIGN KEY (encounter_id, target_wild_no)
  REFERENCES encounter_wild_snapshots(encounter_id, wild_no);

COMMENT ON COLUMN capture_attempts.target_wild_no IS
  'Frozen encounter wild roster position targeted by this capture attempt.';
