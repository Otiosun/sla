-- 0013_domain_admin_operation_integrity.sql
-- Phase 12C: durable result snapshots for owner mutations used by Admin Operations.
-- Migrations 0001-0012 are immutable.

ALTER TABLE inventory_ledger
  ADD COLUMN balance_after BIGINT NULL,
  ADD CONSTRAINT inventory_ledger_balance_after_check
    CHECK (balance_after IS NULL OR balance_after >= 0);

ALTER TABLE wallet_ledger
  ADD COLUMN balance_after BIGINT NULL;

COMMENT ON COLUMN inventory_ledger.balance_after IS
  'Durable post-mutation balance for exact idempotent replay; legacy rows may be NULL.';
COMMENT ON COLUMN wallet_ledger.balance_after IS
  'Durable post-mutation balance for exact idempotent replay; legacy rows may be NULL.';
