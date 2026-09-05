-- 0028_player_access.sql
-- Reception/registration v1: explicit gameplay-access lifecycle after administrative approval.
-- NOTE: If frozen PVP migrations land first, this migration must be renumbered before merge;
-- applied migrations remain immutable.

CREATE TABLE player_access (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROVISIONING', 'ACTIVE', 'SUSPENDED')),
  approved_review_id UUID NULL REFERENCES registration_revisions(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  suspended_reason TEXT NULL,
  suspended_by UUID NULL REFERENCES admin_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'PENDING' AND approved_review_id IS NULL)
    OR
    (status <> 'PENDING' AND approved_review_id IS NOT NULL)
  )
);

CREATE INDEX idx_player_access_status ON player_access(status);
CREATE INDEX idx_player_access_approved_review ON player_access(approved_review_id)
  WHERE approved_review_id IS NOT NULL;

COMMENT ON TABLE player_access IS
  'Gameplay-access lifecycle. APPROVED registration enters PROVISIONING and becomes ACTIVE only after mechanical onboarding and initial world location complete.';

COMMENT ON COLUMN player_access.approved_review_id IS
  'Registration revision that authorized provisioning. Preserved across ACTIVE/SUSPENDED transitions.';
