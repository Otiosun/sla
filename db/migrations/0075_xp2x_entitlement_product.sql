-- 0075_xp2x_entitlement_product.sql
-- Canonical paid 2× Pokémon battle XP product.
-- A purchase grants a timed entitlement beginning when fulfillment actually occurs.
-- Multiple purchases extend duration; the multiplier remains exactly 2×.

INSERT INTO entitlement_definitions(key, grant_model, active, metadata)
VALUES (
  'XP_2X',
  'TIMED',
  TRUE,
  '{"effect":"POKEMON_BATTLE_XP_MULTIPLIER","multiplier":2}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM entitlement_definitions
    WHERE key = 'XP_2X' AND grant_model <> 'TIMED'
  ) THEN
    RAISE EXCEPTION 'XP_2X entitlement already exists with non-TIMED grant model';
  END IF;

  UPDATE entitlement_definitions
  SET active = TRUE,
      metadata = '{"effect":"POKEMON_BATTLE_XP_MULTIPLIER","multiplier":2}'::jsonb,
      updated_at = now()
  WHERE key = 'XP_2X' AND grant_model = 'TIMED';
END
$$;

INSERT INTO premium_product_definitions(
  sku,
  title,
  currency,
  unit_price_cents,
  max_quantity,
  active,
  fulfillment_kind,
  fulfillment_payload,
  metadata
)
VALUES (
  '2XP',
  '2× XP',
  'BRL',
  4000,
  52,
  TRUE,
  'ENTITLEMENT',
  '{"entitlementKey":"XP_2X","grantModel":"TIMED","durationSecondsPerUnit":604800}'::jsonb,
  '{"scope":"POKEMON_BATTLE_XP_ONLY","multiplier":2,"durationDaysPerUnit":7}'::jsonb
)
ON CONFLICT (sku) DO UPDATE
SET title = EXCLUDED.title,
    currency = EXCLUDED.currency,
    unit_price_cents = EXCLUDED.unit_price_cents,
    max_quantity = EXCLUDED.max_quantity,
    active = EXCLUDED.active,
    fulfillment_kind = EXCLUDED.fulfillment_kind,
    fulfillment_payload = EXCLUDED.fulfillment_payload,
    metadata = EXCLUDED.metadata,
    updated_at = now();

COMMENT ON COLUMN premium_product_definitions.max_quantity IS
  'Server-authoritative per-order SKU quantity limit. The client may display this value but may not override it.';
