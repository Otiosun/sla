-- 0018_admin_batch_pipeline.sql
-- Phase 12C / 12.24: durable server-side admin batch pipeline.
-- Migrations 0001-0017 are immutable.

CREATE TABLE admin_batches (
  id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES admin_principals(id),
  status TEXT NOT NULL CHECK (status IN (
    'PREVIEWED', 'READY', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'
  )),
  execution_risk_tier SMALLINT NOT NULL CHECK (execution_risk_tier IN (3, 4)),
  selector JSONB NOT NULL CHECK (jsonb_typeof(selector) = 'object'),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('WALLET_ADJUST', 'INVENTORY_ADJUST')),
  mutation_input JSONB NOT NULL CHECK (jsonb_typeof(mutation_input) = 'object'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  preview_idempotency_key TEXT NOT NULL CHECK (length(preview_idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  correlation_id UUID NOT NULL,
  target_count INTEGER NOT NULL CHECK (target_count >= 0 AND target_count <= 10000),
  sample JSONB NOT NULL CHECK (jsonb_typeof(sample) = 'array'),
  dry_run_summary JSONB NOT NULL CHECK (jsonb_typeof(dry_run_summary) = 'object'),
  chunk_size SMALLINT NOT NULL CHECK (chunk_size BETWEEN 1 AND 100),
  checkpoint_seq INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_seq >= 0),
  authorization_operation_id UUID NULL REFERENCES admin_operations(id),
  report JSONB NULL CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  UNIQUE (principal_id, preview_idempotency_key),
  CHECK (checkpoint_seq <= target_count),
  CHECK (
    (status = 'PREVIEWED' AND authorization_operation_id IS NULL)
    OR (status <> 'PREVIEWED' AND authorization_operation_id IS NOT NULL)
  ),
  CHECK (
    (status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS') AND completed_at IS NOT NULL AND report IS NOT NULL)
    OR (status NOT IN ('COMPLETED', 'COMPLETED_WITH_ERRORS') AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX uq_admin_batches_authorization_operation
  ON admin_batches(authorization_operation_id)
  WHERE authorization_operation_id IS NOT NULL;
CREATE INDEX idx_admin_batches_principal_created
  ON admin_batches(principal_id, created_at DESC);
CREATE INDEX idx_admin_batches_status_updated
  ON admin_batches(status, updated_at);

CREATE TABLE admin_batch_targets (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES admin_batches(id),
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  player_id UUID NOT NULL REFERENCES players(id),
  player_revision BIGINT NOT NULL CHECK (player_revision >= 0),
  resource_revision BIGINT NULL CHECK (resource_revision IS NULL OR resource_revision >= 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  dry_run_ok BOOLEAN NOT NULL,
  dry_run JSONB NOT NULL CHECK (jsonb_typeof(dry_run) = 'object'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'CLAIMED', 'APPLIED', 'SKIPPED', 'FAILED'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result JSONB NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error_code TEXT NULL,
  error_message TEXT NULL,
  processed_at TIMESTAMPTZ NULL,
  UNIQUE (batch_id, sequence_no),
  UNIQUE (batch_id, player_id),
  CHECK (
    (status IN ('PENDING', 'CLAIMED') AND processed_at IS NULL)
    OR (status IN ('APPLIED', 'SKIPPED', 'FAILED') AND processed_at IS NOT NULL)
  ),
  CHECK (
    (status = 'APPLIED' AND result IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
    OR status <> 'APPLIED'
  ),
  CHECK (
    (status IN ('SKIPPED', 'FAILED') AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR status NOT IN ('SKIPPED', 'FAILED')
  )
);

CREATE INDEX idx_admin_batch_targets_pending
  ON admin_batch_targets(batch_id, sequence_no)
  WHERE status IN ('PENDING', 'CLAIMED');
CREATE INDEX idx_admin_batch_targets_player
  ON admin_batch_targets(player_id, batch_id);

CREATE OR REPLACE FUNCTION guard_admin_batch_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.execution_risk_tier IS DISTINCT FROM OLD.execution_risk_tier
     OR NEW.selector IS DISTINCT FROM OLD.selector
     OR NEW.mutation_kind IS DISTINCT FROM OLD.mutation_kind
     OR NEW.mutation_input IS DISTINCT FROM OLD.mutation_input
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.preview_idempotency_key IS DISTINCT FROM OLD.preview_idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.target_count IS DISTINCT FROM OLD.target_count
     OR NEW.sample IS DISTINCT FROM OLD.sample
     OR NEW.dry_run_summary IS DISTINCT FROM OLD.dry_run_summary
     OR NEW.chunk_size IS DISTINCT FROM OLD.chunk_size
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'admin batch snapshot is immutable after preview' USING ERRCODE = '55000';
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'admin batch revision must advance exactly once per update' USING ERRCODE = '55000';
  END IF;
  IF NEW.checkpoint_seq < OLD.checkpoint_seq THEN
    RAISE EXCEPTION 'admin batch checkpoint cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF OLD.authorization_operation_id IS NOT NULL
     AND NEW.authorization_operation_id IS DISTINCT FROM OLD.authorization_operation_id THEN
    RAISE EXCEPTION 'admin batch authorization operation is immutable once assigned' USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD.status = 'PREVIEWED' AND NEW.status = 'READY')
    OR (OLD.status = 'READY' AND NEW.status IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'))
  ) THEN
    RAISE EXCEPTION 'invalid admin batch status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admin_batch_snapshot
BEFORE UPDATE ON admin_batches
FOR EACH ROW EXECUTE FUNCTION guard_admin_batch_snapshot();

CREATE OR REPLACE FUNCTION guard_admin_batch_target()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.sequence_no IS DISTINCT FROM OLD.sequence_no
     OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.player_revision IS DISTINCT FROM OLD.player_revision
     OR NEW.resource_revision IS DISTINCT FROM OLD.resource_revision
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.dry_run_ok IS DISTINCT FROM OLD.dry_run_ok
     OR NEW.dry_run IS DISTINCT FROM OLD.dry_run THEN
    RAISE EXCEPTION 'admin batch target snapshot is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'PENDING' AND NEW.status = 'CLAIMED' THEN
    IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'claim must increment batch target attempt_count exactly once'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'PENDING' AND NEW.status = 'SKIPPED' THEN
    IF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'dry-run/stale skip must not increment batch target attempt_count'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'CLAIMED' AND NEW.status IN ('APPLIED', 'FAILED') THEN
    IF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'terminal claimed target must preserve attempt_count'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid admin batch target status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admin_batch_target
BEFORE UPDATE ON admin_batch_targets
FOR EACH ROW EXECUTE FUNCTION guard_admin_batch_target();

CREATE OR REPLACE FUNCTION guard_admin_batch_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin batch history cannot be deleted' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_admin_batch_delete
BEFORE DELETE ON admin_batches
FOR EACH ROW EXECUTE FUNCTION guard_admin_batch_delete();
CREATE TRIGGER trg_admin_batch_target_delete
BEFORE DELETE ON admin_batch_targets
FOR EACH ROW EXECUTE FUNCTION guard_admin_batch_delete();
