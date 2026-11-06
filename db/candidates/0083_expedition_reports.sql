-- Inert candidate. No default rewards, odds or production activation.
CREATE TABLE solo_expedition_reports (
  id uuid PRIMARY KEY,
  expedition_id uuid NOT NULL UNIQUE REFERENCES solo_expeditions(id),
  player_id uuid NOT NULL REFERENCES players(id),
  external_ref text NOT NULL CHECK (char_length(external_ref) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN ('SUBMITTED','APPROVED','REJECTED')),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  reviewed_word_count integer NULL CHECK(reviewed_word_count>=0),
  approval_mode text NULL CHECK(approval_mode IN ('NORMAL','HIGHLIGHT','REJECTED')),
  admin_operation_id uuid NULL UNIQUE REFERENCES admin_operations(id),
  policy_release_id uuid NULL REFERENCES content_releases(id),
  reward_result jsonb NULL CHECK(reward_result IS NULL OR jsonb_typeof(reward_result)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  CHECK ((status='SUBMITTED' AND admin_operation_id IS NULL AND approval_mode IS NULL AND reviewed_at IS NULL AND reward_result IS NULL)
    OR (status='REJECTED' AND approval_mode='REJECTED' AND admin_operation_id IS NOT NULL AND reviewed_at IS NOT NULL AND reward_result IS NULL)
    OR (status='APPROVED' AND approval_mode IN ('NORMAL','HIGHLIGHT') AND reviewed_word_count IS NOT NULL AND reviewed_word_count>=100 AND admin_operation_id IS NOT NULL AND reviewed_at IS NOT NULL AND policy_release_id IS NOT NULL AND reward_result IS NOT NULL))
);
CREATE TABLE solo_report_reward_policies (
  content_release_id uuid PRIMARY KEY REFERENCES content_releases(id),
  config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
  approval_ref text NOT NULL CHECK(char_length(trim(approval_ref)) BETWEEN 1 AND 200),
  approved_at timestamptz NOT NULL
);
CREATE TRIGGER solo_report_reward_policy_draft_only BEFORE INSERT OR UPDATE OR DELETE ON solo_report_reward_policies
  FOR EACH ROW EXECUTE FUNCTION prevent_unapproved_search_policy_write();
