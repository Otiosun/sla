-- 0061_reception_strict_capabilities.sql
-- Reception is intentionally registration-only. Keep review routing available to assigned admins,
-- and remove gameplay/world capabilities from every existing Reception group.

UPDATE community_group_capabilities capability
SET active = FALSE, updated_at = now()
FROM community_groups group_row
WHERE capability.group_id = group_row.id
  AND group_row.role = 'RECEPTION'
  AND capability.active = TRUE
  AND capability.capability_key NOT IN ('onboarding', 'admin.review');

INSERT INTO community_group_capabilities(group_id, capability_key, active, created_at, updated_at)
SELECT group_row.id, required.capability_key, TRUE, now(), now()
FROM community_groups group_row
CROSS JOIN (VALUES ('onboarding'), ('admin.review')) AS required(capability_key)
WHERE group_row.role = 'RECEPTION'
ON CONFLICT (group_id, capability_key)
DO UPDATE SET active = TRUE, updated_at = now();

UPDATE community_groups group_row
SET revision = revision + 1, updated_at = now()
WHERE group_row.role = 'RECEPTION';
