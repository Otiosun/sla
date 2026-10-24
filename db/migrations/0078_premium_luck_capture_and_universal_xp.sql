-- 0078_premium_luck_capture_and_universal_xp.sql
-- XP_2X covers earned Pokemon and trainer XP; corrective admin edits are excluded.
-- LUCK is a permanent capture-probability entitlement. Never doubles item consumption,
-- award quantities or the result of an already-committed capture.
-- No existing player entitlements, capture rolls or earned XP are rewritten.

UPDATE entitlement_definitions
SET metadata = '{"effect":"ALL_EARNED_XP_MULTIPLIER","multiplier":2}'::jsonb,
    updated_at = now()
WHERE key = 'XP_2X' AND grant_model = 'TIMED';

UPDATE premium_product_definitions
SET metadata = '{"scope":"ALL_EARNED_XP","multiplier":2,"durationDaysPerUnit":7}'::jsonb,
    updated_at = now()
WHERE sku = '2XP' AND fulfillment_kind = 'ENTITLEMENT';

COMMENT ON FUNCTION pokemon_battle_xp_multiplier_for(UUID, TIMESTAMPTZ) IS
  'Historical function name: returns 2 for active XP_2X. Also used for trainer XP earned from gameplay and future system rewards; never doubles corrections.';

INSERT INTO entitlement_definitions(key, grant_model, active, metadata)
VALUES ('CAPTURE_LUCK_2X', 'PERMANENT', TRUE,
        '{"effect":"CAPTURE_PROBABILITY_MULTIPLIER","multiplier":2}'::jsonb)
ON CONFLICT (key) DO UPDATE
SET active = TRUE,
    metadata = '{"effect":"CAPTURE_PROBABILITY_MULTIPLIER","multiplier":2}'::jsonb,
    updated_at = now()
WHERE entitlement_definitions.grant_model = 'PERMANENT';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM entitlement_definitions
    WHERE key = 'CAPTURE_LUCK_2X' AND grant_model = 'PERMANENT'
  ) THEN
    RAISE EXCEPTION 'CAPTURE_LUCK_2X is not a permanent entitlement';
  END IF;
END
$$;

INSERT INTO premium_product_definitions(
  sku, title, currency, unit_price_cents, max_quantity, active,
  fulfillment_kind, fulfillment_payload, metadata
)
VALUES (
  'LUCK', 'Bênção da Sorte', 'BRL', 4500, 1, TRUE,
  'ENTITLEMENT',
  '{"entitlementKey":"CAPTURE_LUCK_2X","grantModel":"PERMANENT"}'::jsonb,
  '{"scope":"ALL_AUTHORIZED_CAPTURES","multiplier":2,"stacking":"MAX_2X","duration":"PERMANENT"}'::jsonb
)
ON CONFLICT (sku) DO UPDATE
SET title = EXCLUDED.title,
    unit_price_cents = EXCLUDED.unit_price_cents,
    max_quantity = EXCLUDED.max_quantity,
    active = EXCLUDED.active,
    fulfillment_kind = EXCLUDED.fulfillment_kind,
    fulfillment_payload = EXCLUDED.fulfillment_payload,
    metadata = EXCLUDED.metadata,
    updated_at = now();

CREATE OR REPLACE FUNCTION premium_capture_luck_multiplier_for(
  p_player_id UUID, p_at TIMESTAMPTZ
) RETURNS SMALLINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM player_entitlements ent
    WHERE ent.player_id = p_player_id
      AND ent.entitlement_key = 'CAPTURE_LUCK_2X'
      AND ent.grant_model = 'PERMANENT'
      AND ent.administrative_status = 'ACTIVE'
      AND ent.starts_at <= p_at
  ) THEN 2::SMALLINT ELSE 1::SMALLINT END;
$$;

COMMENT ON FUNCTION premium_capture_luck_multiplier_for(UUID, TIMESTAMPTZ) IS
  'Server-owned capture chance multiplier, 1 or 2 (never stacks), applied inside the durable capture transaction before RNG roll and final ruleset clamp.';
