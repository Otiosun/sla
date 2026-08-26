-- 0005_economy_integrity_and_offers.sql
-- Phase 6: harden economy audit metadata, wallet invariants, and server-authoritative offers.
-- Migrations 0001-0004 are frozen and intentionally untouched.

UPDATE inventory_ledger
SET reason = COALESCE(reason, 'legacy-unspecified'),
    correlation_id = COALESCE(correlation_id, id)
WHERE reason IS NULL OR correlation_id IS NULL;

UPDATE wallet_ledger
SET reason = COALESCE(reason, 'legacy-unspecified'),
    correlation_id = COALESCE(correlation_id, id)
WHERE reason IS NULL OR correlation_id IS NULL;

ALTER TABLE inventory_ledger
  ALTER COLUMN reason SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL,
  ADD CONSTRAINT inventory_ledger_reason_not_blank CHECK (btrim(reason) <> '');

ALTER TABLE wallet_ledger
  ALTER COLUMN reason SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL,
  ADD CONSTRAINT wallet_ledger_reason_not_blank CHECK (btrim(reason) <> '');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM wallet_balances balance
    JOIN currency_definitions currency ON currency.id = balance.currency_id
    WHERE balance.amount < 0 AND currency.allows_negative = FALSE
  ) THEN
    RAISE EXCEPTION 'wallet_balances contains a negative balance for a non-negative currency'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wallet_balance_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  negative_allowed BOOLEAN;
BEGIN
  SELECT allows_negative INTO negative_allowed
  FROM currency_definitions
  WHERE id = NEW.currency_id;

  IF negative_allowed IS NULL THEN
    RAISE EXCEPTION 'currency % does not exist', NEW.currency_id USING ERRCODE = '23503';
  END IF;

  IF NEW.amount < 0 AND negative_allowed = FALSE THEN
    RAISE EXCEPTION 'currency % does not allow negative wallet balances', NEW.currency_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_wallet_balances_negative_policy
BEFORE INSERT OR UPDATE OF currency_id, amount ON wallet_balances
FOR EACH ROW EXECUTE FUNCTION guard_wallet_balance_policy();

CREATE TABLE item_purchase_offers (
  id UUID PRIMARY KEY,
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  offer_key TEXT NOT NULL CHECK (offer_key ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  item_id UUID NOT NULL REFERENCES items(id),
  currency_id UUID NOT NULL REFERENCES currency_definitions(id),
  item_quantity BIGINT NOT NULL CHECK (item_quantity > 0),
  price_amount BIGINT NOT NULL CHECK (price_amount > 0),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (content_release_id, offer_key)
);

CREATE INDEX idx_item_purchase_offers_release_active
  ON item_purchase_offers(content_release_id, active, sort_order, offer_key);

CREATE TRIGGER trg_item_purchase_offers_release_guard
BEFORE INSERT OR UPDATE OR DELETE ON item_purchase_offers
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
