-- 0041_admin_operation_policy_reason.sql
-- Admin operation reason requirements are declared by the immutable operation policy snapshot.
-- The legacy risk-tier-wide constraint predates per-operation requires_reason and blocks
-- legitimate Tier 2 registration review decisions whose approved product contract does not
-- require an embedded reason. Keep the policy-specific DB constraint fail-closed.

ALTER TABLE admin_operations
  DROP CONSTRAINT IF EXISTS admin_operations_sensitive_reason_check;

COMMENT ON COLUMN admin_operations.requires_reason IS
  'Canonical persisted policy flag controlling whether reason is mandatory; enforced by admin_operations_policy_reason_check and AdminService.';
