-- Inert candidate: apply only to an owned disposable rehearsal database.
CREATE TABLE pvp_group_timing (
  group_id uuid PRIMARY KEY REFERENCES community_groups(id),
  turn_ttl_ms bigint NOT NULL CHECK (turn_ttl_ms > 0 AND turn_ttl_ms <= 9007199254740991),
  admin_operation_id uuid NOT NULL REFERENCES admin_operations(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
