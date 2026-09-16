-- Controller resolutions enqueue defeat delivery in the same transaction as the turn.
CREATE TABLE battle_defeat_aftermath (
  battle_id UUID PRIMARY KEY REFERENCES battles(id) ON DELETE RESTRICT,
  battle_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  FOREIGN KEY (battle_id, battle_version)
    REFERENCES battle_state_snapshots(battle_id, version) ON DELETE RESTRICT
);

CREATE INDEX battle_defeat_aftermath_pending
  ON battle_defeat_aftermath(created_at, battle_id) WHERE completed_at IS NULL;
