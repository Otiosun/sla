-- 0027_registration_review.sql
-- Reception/registration v1: durable drafts, immutable review snapshots and replay receipts.
-- NOTE: 0027 is contiguous with canonical main (0026). If frozen PVP migrations land first,
-- this migration must be renumbered before merge; applied migrations remain immutable.

CREATE TABLE registration_drafts (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE registration_revisions (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  sequence_no BIGINT NOT NULL CHECK (sequence_no > 0),
  status TEXT NOT NULL CHECK (
    status IN ('SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  decided_by_admin_principal_id UUID NULL REFERENCES admin_principals(id) ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, sequence_no),
  CHECK (
    (status IN ('APPROVED', 'REJECTED') AND decided_by_admin_principal_id IS NOT NULL AND decided_at IS NOT NULL)
    OR
    (status NOT IN ('APPROVED', 'REJECTED') AND decided_by_admin_principal_id IS NULL AND decided_at IS NULL)
  )
);

CREATE INDEX idx_registration_revisions_player_sequence
  ON registration_revisions(player_id, sequence_no DESC);

CREATE TABLE registration_idempotency_receipts (
  operation TEXT NOT NULL CHECK (operation IN ('SUBMIT', 'REQUEST_CHANGES', 'APPROVE', 'REJECT')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  revision_id UUID NOT NULL REFERENCES registration_revisions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operation, idempotency_key)
);

CREATE OR REPLACE FUNCTION protect_registration_revision_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.sequence_no IS DISTINCT FROM OLD.sequence_no
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'registration revision snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_registration_revision_snapshot_immutable
BEFORE UPDATE ON registration_revisions
FOR EACH ROW EXECUTE FUNCTION protect_registration_revision_snapshot();

COMMENT ON TABLE registration_drafts IS
  'Mutable saved registration draft. Conversational edits remain ephemeral until explicitly saved or submitted.';

COMMENT ON TABLE registration_revisions IS
  'Immutable submitted registration snapshots with optimistic decision revision and human-admin review state.';

COMMENT ON TABLE registration_idempotency_receipts IS
  'Replay receipts for registration submission and administrative review operations.';
