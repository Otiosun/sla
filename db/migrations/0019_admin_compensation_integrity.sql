-- 0019_admin_compensation_integrity.sql
-- Phase 12 / 12.13: explicit compensation linkage. Compensation never rewrites
-- historical owner evidence and is only created for allowlisted semantic inverses.
-- Migrations 0001-0018 are immutable.

CREATE TABLE admin_operation_compensations (
  id UUID PRIMARY KEY,
  source_admin_operation_id UUID NOT NULL UNIQUE REFERENCES admin_operations(id),
  compensation_admin_operation_id UUID NOT NULL UNIQUE REFERENCES admin_operations(id),
  compensation_kind TEXT NOT NULL CHECK (compensation_kind = 'INVERSE_DELTA_V1'),
  created_by_admin_principal_id UUID NOT NULL REFERENCES admin_principals(id),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_admin_operation_id <> compensation_admin_operation_id)
);

CREATE INDEX idx_admin_operation_compensations_compensation
  ON admin_operation_compensations(compensation_admin_operation_id);
CREATE INDEX idx_admin_operation_compensations_created
  ON admin_operation_compensations(created_at DESC);

CREATE OR REPLACE FUNCTION guard_admin_operation_compensation_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin operation compensation links are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_admin_operation_compensation_immutable
BEFORE UPDATE OR DELETE ON admin_operation_compensations
FOR EACH ROW EXECUTE FUNCTION guard_admin_operation_compensation_immutable();
