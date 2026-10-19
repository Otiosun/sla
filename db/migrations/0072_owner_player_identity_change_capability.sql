-- 0063_owner_player_identity_change_capability.sql
-- Register the risk-4 WhatsApp identity-change capability for existing installations.
-- Fresh installations may not have canonical admin roles yet; the later bootstrap reconciliation
-- will grant the capability from registry-catalog.ts.

INSERT INTO capabilities(id, key, risk_tier)
VALUES (gen_random_uuid(), 'player.identity.change', 4)
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  persisted_risk SMALLINT;
BEGIN
  SELECT risk_tier
  INTO persisted_risk
  FROM capabilities
  WHERE key = 'player.identity.change';

  IF persisted_risk IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Canonical admin capability risk drift detected for player.identity.change';
  END IF;
END
$$;

INSERT INTO admin_role_capabilities(role_id, capability_id)
SELECT role.id, capability.id
FROM admin_roles role
JOIN capabilities capability ON capability.key = 'player.identity.change'
WHERE role.slug = 'OWNER_SECURITY_ADMIN'
ON CONFLICT (role_id, capability_id) DO NOTHING;

DELETE FROM admin_role_capabilities relation
USING admin_roles role, capabilities capability
WHERE relation.role_id = role.id
  AND relation.capability_id = capability.id
  AND capability.key = 'player.identity.change'
  AND role.slug <> 'OWNER_SECURITY_ADMIN';
