-- Durable, explicitly non-production onboarding path for administrative UAT actors.
ALTER TABLE player_access ADD COLUMN access_origin TEXT NOT NULL DEFAULT 'NORMAL'
  CHECK (access_origin IN ('NORMAL', 'UAT_BOOTSTRAP'));
ALTER TABLE player_access DROP CONSTRAINT player_access_check;
ALTER TABLE player_access ADD CONSTRAINT player_access_origin_check CHECK (
  (access_origin = 'NORMAL' AND ((status = 'PENDING' AND approved_review_id IS NULL) OR (status <> 'PENDING' AND approved_review_id IS NOT NULL)))
  OR (access_origin = 'UAT_BOOTSTRAP' AND status = 'ACTIVE' AND approved_review_id IS NULL)
);
CREATE TABLE player_uat_bootstraps (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  bootstrapped_by UUID NOT NULL REFERENCES admin_principals(id) ON DELETE RESTRICT,
  bootstrapped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_prepared_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE player_uat_bootstraps IS 'Explicit audit marker for accounts mechanically prepared through UAT_BOOTSTRAP; it never changes battle rules.';
