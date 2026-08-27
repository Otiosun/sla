-- 0011_admin_operation_registry_integrity.sql
-- Hardens the pre-existing admin authorization/operation spine without replacing it.

ALTER TABLE admin_principals
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0);

ALTER TABLE admin_roles
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0);

ALTER TABLE capabilities
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0);

ALTER TABLE admin_operations
  DROP CONSTRAINT IF EXISTS admin_operations_status_check;

ALTER TABLE admin_operations
  ADD CONSTRAINT admin_operations_status_check
  CHECK (status IN (
    'DRAFT', 'VALIDATED', 'SIMULATED', 'PENDING_CONFIRMATION', 'PENDING_APPROVAL',
    'READY', 'APPLIED', 'REJECTED', 'FAILED', 'COMPENSATED'
  ));

ALTER TABLE admin_operations
  ALTER COLUMN reason DROP NOT NULL,
  ADD COLUMN request_fingerprint TEXT,
  ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  ADD COLUMN requires_simulation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN required_approvals SMALLINT NOT NULL DEFAULT 0 CHECK (required_approvals BETWEEN 0 AND 2),
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE admin_operations
SET request_fingerprint = 'legacy:' || id::text
WHERE request_fingerprint IS NULL;

ALTER TABLE admin_operations
  ALTER COLUMN request_fingerprint SET NOT NULL,
  ADD CONSTRAINT admin_operations_sensitive_reason_check
    CHECK (risk_tier < 2 OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
  ADD CONSTRAINT admin_operations_applied_at_check
    CHECK (
      (status IN ('APPLIED', 'COMPENSATED') AND applied_at IS NOT NULL)
      OR (status NOT IN ('APPLIED', 'COMPENSATED') AND applied_at IS NULL)
    );

CREATE INDEX idx_admin_operations_status_created
  ON admin_operations(status, created_at);

CREATE TABLE admin_principal_scopes (
  id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES admin_principals(id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('GLOBAL', 'PLAYER', 'REGION', 'AREA')),
  scope_id UUID NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  CHECK (
    (scope_type = 'GLOBAL' AND scope_id IS NULL)
    OR (scope_type <> 'GLOBAL' AND scope_id IS NOT NULL)
  ),
  CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_admin_principal_scopes_active
  ON admin_principal_scopes(
    principal_id,
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'ACTIVE';

CREATE INDEX idx_admin_principal_scopes_principal
  ON admin_principal_scopes(principal_id, status);

CREATE TABLE admin_operation_confirmations (
  id UUID PRIMARY KEY,
  admin_operation_id UUID NOT NULL REFERENCES admin_operations(id),
  principal_id UUID NOT NULL REFERENCES admin_principals(id),
  request_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_operation_id, principal_id)
);

CREATE INDEX idx_admin_operation_confirmations_operation
  ON admin_operation_confirmations(admin_operation_id, created_at);

CREATE TABLE admin_operation_approvals (
  id UUID PRIMARY KEY,
  admin_operation_id UUID NOT NULL REFERENCES admin_operations(id),
  principal_id UUID NOT NULL REFERENCES admin_principals(id),
  request_fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_operation_id, principal_id)
);

CREATE INDEX idx_admin_operation_approvals_operation
  ON admin_operation_approvals(admin_operation_id, created_at);
