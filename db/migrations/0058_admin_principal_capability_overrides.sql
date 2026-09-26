-- 0058_admin_principal_capability_overrides.sql
-- Individual administrative capability overrides with owner protection.

-- Extend low-risk admin batch snapshots to the new Pokédex seen grant.
ALTER TABLE admin_batches
  DROP CONSTRAINT admin_batches_child_operation_type_check,
  DROP CONSTRAINT admin_batches_child_capability_key_check;

ALTER TABLE admin_batches
  ADD CONSTRAINT admin_batches_child_operation_type_check CHECK (
    child_operation_type IN (
      'inventory.adjust',
      'wallet.adjust',
      'progression.trainer.adjust',
      'pokedex.seen.grant'
    )
  ),
  ADD CONSTRAINT admin_batches_child_capability_key_check CHECK (
    child_capability_key IN (
      'inventory.adjust',
      'wallet.adjust',
      'progression.adjust',
      'pokedex.seen.grant'
    )
  );

CREATE TABLE admin_principal_capability_overrides (
  principal_id UUID NOT NULL REFERENCES admin_principals(id) ON DELETE CASCADE,
  capability_id UUID NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('GRANT', 'DENY')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  assigned_by_admin_principal_id UUID NOT NULL REFERENCES admin_principals(id),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, capability_id)
);

CREATE INDEX idx_admin_principal_capability_overrides_actor
  ON admin_principal_capability_overrides(assigned_by_admin_principal_id, updated_at DESC);

CREATE OR REPLACE FUNCTION reject_owner_capability_override()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM admin_principal_roles relation
    JOIN admin_roles role ON role.id = relation.role_id
    WHERE relation.principal_id = NEW.principal_id
      AND role.slug = 'OWNER_SECURITY_ADMIN'
  ) THEN
    RAISE EXCEPTION 'owner capability overrides are forbidden';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admin_owner_capability_override_guard
BEFORE INSERT OR UPDATE ON admin_principal_capability_overrides
FOR EACH ROW EXECUTE FUNCTION reject_owner_capability_override();

CREATE OR REPLACE VIEW admin_effective_capabilities AS
WITH role_grants AS (
  SELECT principal_role.principal_id, capability.id AS capability_id
  FROM admin_principal_roles principal_role
  JOIN admin_role_capabilities role_capability ON role_capability.role_id = principal_role.role_id
  JOIN capabilities capability ON capability.id = role_capability.capability_id
),
direct_grants AS (
  SELECT override.principal_id, override.capability_id
  FROM admin_principal_capability_overrides override
  WHERE override.decision = 'GRANT'
),
denials AS (
  SELECT override.principal_id, override.capability_id
  FROM admin_principal_capability_overrides override
  WHERE override.decision = 'DENY'
),
combined AS (
  SELECT * FROM role_grants
  UNION
  SELECT * FROM direct_grants
)
SELECT combined.principal_id,
       capability.id AS capability_id,
       capability.key,
       capability.risk_tier
FROM combined
JOIN capabilities capability ON capability.id = combined.capability_id
WHERE NOT EXISTS (
  SELECT 1
  FROM denials
  WHERE denials.principal_id = combined.principal_id
    AND denials.capability_id = combined.capability_id
);
