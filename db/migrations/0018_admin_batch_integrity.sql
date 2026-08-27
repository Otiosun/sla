-- 0018_admin_batch_integrity.sql
-- Phase 12D / 12.24-12.25: server-side batch snapshots, resumable checkpoints and
-- per-target exactly-once evidence. Migrations 0001-0017 are immutable.

CREATE TABLE admin_batches (
  id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES admin_principals(id),
  preview_admin_operation_id UUID NOT NULL UNIQUE REFERENCES admin_operations(id),
  execute_admin_operation_id UUID NULL UNIQUE REFERENCES admin_operations(id),
  child_operation_type TEXT NOT NULL CHECK (child_operation_type IN (
    'inventory.adjust', 'wallet.adjust', 'progression.trainer.adjust'
  )),
  child_capability_key TEXT NOT NULL CHECK (child_capability_key IN (
    'inventory.adjust', 'wallet.adjust', 'progression.adjust'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'PREVIEWED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'
  )),
  selector JSONB NOT NULL CHECK (jsonb_typeof(selector) = 'object'),
  shared_input JSONB NOT NULL CHECK (jsonb_typeof(shared_input) = 'object'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  target_count INTEGER NOT NULL CHECK (target_count > 0 AND target_count <= 1000),
  checkpoint_ordinal INTEGER NOT NULL DEFAULT -1 CHECK (checkpoint_ordinal >= -1),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  report JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(report) = 'object'),
  correlation_id UUID NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  CHECK (checkpoint_ordinal < target_count),
  CHECK (success_count + failure_count <= target_count),
  CHECK (
    (status = 'PREVIEWED' AND execute_admin_operation_id IS NULL AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'RUNNING' AND execute_admin_operation_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS') AND execute_admin_operation_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NOT NULL AND success_count + failure_count = target_count)
  )
);

CREATE INDEX idx_admin_batches_principal_created
  ON admin_batches(principal_id, created_at DESC);
CREATE INDEX idx_admin_batches_status_created
  ON admin_batches(status, created_at);

CREATE TABLE admin_batch_targets (
  batch_id UUID NOT NULL REFERENCES admin_batches(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  player_id UUID NOT NULL REFERENCES players(id),
  child_input JSONB NOT NULL CHECK (jsonb_typeof(child_input) = 'object'),
  child_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(child_idempotency_key) BETWEEN 8 AND 128),
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE (batch_id, player_id)
);

CREATE INDEX idx_admin_batch_targets_player
  ON admin_batch_targets(player_id, batch_id);

CREATE TABLE admin_batch_target_results (
  batch_id UUID NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  child_admin_operation_id UUID NULL REFERENCES admin_operations(id),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  result JSONB NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error_code TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, ordinal),
  FOREIGN KEY (batch_id, ordinal) REFERENCES admin_batch_targets(batch_id, ordinal) ON DELETE CASCADE,
  CHECK (
    (status = 'PENDING' AND result IS NULL AND error_code IS NULL)
    OR (status = 'SUCCEEDED' AND result IS NOT NULL AND error_code IS NULL AND child_admin_operation_id IS NOT NULL)
    OR (status = 'FAILED' AND result IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX idx_admin_batch_target_results_pending
  ON admin_batch_target_results(batch_id, ordinal)
  WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION guard_admin_batch_target_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin batch target snapshots are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_admin_batch_target_immutable
BEFORE UPDATE OR DELETE ON admin_batch_targets
FOR EACH ROW EXECUTE FUNCTION guard_admin_batch_target_immutable();

CREATE OR REPLACE FUNCTION guard_admin_batch_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.preview_admin_operation_id IS DISTINCT FROM OLD.preview_admin_operation_id
    OR NEW.child_operation_type IS DISTINCT FROM OLD.child_operation_type
    OR NEW.child_capability_key IS DISTINCT FROM OLD.child_capability_key
    OR NEW.selector IS DISTINCT FROM OLD.selector
    OR NEW.shared_input IS DISTINCT FROM OLD.shared_input
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.target_count IS DISTINCT FROM OLD.target_count
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'admin batch semantic snapshot is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.execute_admin_operation_id IS NOT NULL
    AND NEW.execute_admin_operation_id IS DISTINCT FROM OLD.execute_admin_operation_id
  THEN
    RAISE EXCEPTION 'admin batch execution owner is immutable once claimed' USING ERRCODE = '55000';
  END IF;

  IF NEW.checkpoint_ordinal < OLD.checkpoint_ordinal
    OR NEW.success_count < OLD.success_count
    OR NEW.failure_count < OLD.failure_count
    OR NEW.revision < OLD.revision
  THEN
    RAISE EXCEPTION 'admin batch checkpoint/counters/revision cannot move backwards' USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal admin batch is immutable' USING ERRCODE = '55000';
  END IF;

  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'PREVIEWED' AND NEW.status = 'RUNNING')
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS'))
  ) THEN
    RAISE EXCEPTION 'invalid admin batch lifecycle transition' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admin_batch_update
BEFORE UPDATE ON admin_batches
FOR EACH ROW EXECUTE FUNCTION guard_admin_batch_update();
