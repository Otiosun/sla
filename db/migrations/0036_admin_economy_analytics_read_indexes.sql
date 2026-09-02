-- Add bounded global economy analytics indexes without rewriting history.
CREATE INDEX idx_wallet_ledger_created_currency
  ON wallet_ledger(created_at DESC, currency_id);

CREATE INDEX idx_inventory_ledger_created
  ON inventory_ledger(created_at DESC);
