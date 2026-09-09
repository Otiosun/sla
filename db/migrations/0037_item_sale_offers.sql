-- 0037_item_sale_offers.sql
-- World Services V1: content-driven Poké Mart sale offers.

CREATE TABLE item_sale_offers (
  id UUID PRIMARY KEY,
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  offer_key TEXT NOT NULL CHECK (offer_key ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  item_id UUID NOT NULL REFERENCES items(id),
  currency_id UUID NOT NULL REFERENCES currency_definitions(id),
  sale_amount BIGINT NOT NULL CHECK (sale_amount > 0),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (content_release_id, offer_key)
);

CREATE INDEX idx_item_sale_offers_release_active
  ON item_sale_offers(content_release_id, active, sort_order, offer_key);

CREATE TRIGGER trg_item_sale_offers_release_guard
BEFORE INSERT OR UPDATE OR DELETE ON item_sale_offers
FOR EACH ROW EXECUTE FUNCTION guard_release_child_mutation();
