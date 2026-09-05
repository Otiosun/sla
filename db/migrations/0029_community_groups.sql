-- 0029_community_groups.sql
-- Reception/registration v1: durable WhatsApp group registry, capabilities, staff assignments and presence.
-- NOTE: If frozen FLOW/PVP migrations land first, renumber before merge; applied migrations remain immutable.

CREATE TABLE community_groups (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
  chat_ref TEXT NOT NULL CHECK (btrim(chat_ref) <> ''),
  role TEXT NOT NULL CHECK (role IN ('RECEPTION', 'GAME', 'PVP', 'COMMUNITY', 'STAFF')),
  display_name TEXT NOT NULL CHECK (btrim(display_name) <> ''),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  UNIQUE (provider, chat_ref),
  CHECK (
    (status = 'ACTIVE' AND retired_at IS NULL)
    OR
    (status = 'RETIRED' AND retired_at IS NOT NULL)
  )
);

CREATE INDEX idx_community_groups_role_status
  ON community_groups(role, status);

CREATE TABLE community_group_capabilities (
  group_id UUID NOT NULL REFERENCES community_groups(id) ON DELETE RESTRICT,
  capability_key TEXT NOT NULL CHECK (
    capability_key IN (
      'onboarding',
      'player.basic',
      'admin.review',
      'world',
      'pve',
      'pvp',
      'admin',
      'observability'
    )
  ),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, capability_key)
);

CREATE INDEX idx_community_group_capabilities_active
  ON community_group_capabilities(group_id, capability_key)
  WHERE active;

CREATE TABLE reception_staff_assignments (
  group_id UUID NOT NULL REFERENCES community_groups(id) ON DELETE RESTRICT,
  admin_principal_id UUID NOT NULL REFERENCES admin_principals(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, admin_principal_id)
);

CREATE INDEX idx_reception_staff_assignments_active
  ON reception_staff_assignments(group_id, admin_principal_id)
  WHERE active;

CREATE TABLE community_member_presence (
  group_id UUID NOT NULL REFERENCES community_groups(id) ON DELETE RESTRICT,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  presence_generation BIGINT NOT NULL DEFAULT 0 CHECK (presence_generation >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_joined_at TIMESTAMPTZ NULL,
  last_left_at TIMESTAMPTZ NULL,
  last_welcome_at TIMESTAMPTZ NULL,
  PRIMARY KEY (group_id, player_id),
  CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX idx_community_member_presence_player
  ON community_member_presence(player_id, last_seen_at DESC);

COMMENT ON TABLE community_groups IS
  'Provider/chatRef group registry used for authorization. Display names are never authority.';

COMMENT ON TABLE community_group_capabilities IS
  'Group-level routing capabilities. Inactive rows preserve least-privilege replacement without runtime DELETE.';

COMMENT ON TABLE reception_staff_assignments IS
  'Reception routing assignments only; membership never grants administrative authority.';

COMMENT ON TABLE community_member_presence IS
  'Observed group presence for welcome/rejoin UX. Presence never grants or revokes gameplay authority.';
