CREATE TABLE encounter_wild_snapshots (
  encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  wild_no SMALLINT NOT NULL CHECK (wild_no BETWEEN 1 AND 6),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'CAPTURED', 'FAINTED', 'FLED')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  pokemon_snapshot JSONB NOT NULL CHECK (jsonb_typeof(pokemon_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (encounter_id, wild_no)
);

INSERT INTO encounter_wild_snapshots(
  encounter_id, wild_no, status, schema_version, pokemon_snapshot, created_at, updated_at
)
SELECT encounter_id, 1, 'ACTIVE', schema_version, pokemon_snapshot, created_at, created_at
FROM encounter_snapshots;

CREATE INDEX idx_encounter_wild_snapshots_active
  ON encounter_wild_snapshots(encounter_id, wild_no)
  WHERE status = 'ACTIVE';

COMMENT ON TABLE encounter_wild_snapshots IS
  'Frozen narrator-spawn wild roster. encounter_snapshots remains the compatibility mirror for wild_no=1.';
