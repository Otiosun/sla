-- 0034_registration_conversation_state.sql
-- Durable, restart-safe conversational state for WhatsApp Registration v2.

CREATE TABLE registration_conversations (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  chat_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'MODE_SELECT',
    'GUIDED_FIELD',
    'FULL_FORM',
    'REVIEW',
    'EDIT_SELECT',
    'EDIT_FIELD',
    'PAUSED',
    'RESUME_MENU',
    'RESTART_CONFIRM',
    'SUBMITTED'
  )),
  editing_mode TEXT NULL CHECK (
    editing_mode IS NULL OR editing_mode IN ('GUIDED', 'FULL')
  ),
  current_field TEXT NULL CHECK (
    current_field IS NULL OR current_field IN (
      'trainerName',
      'age',
      'genderPronouns',
      'appearance',
      'personality',
      'backstory',
      'starterFormId'
    )
  ),
  edit_field TEXT NULL CHECK (
    edit_field IS NULL OR edit_field IN (
      'trainerName',
      'age',
      'genderPronouns',
      'appearance',
      'personality',
      'backstory',
      'starterFormId'
    )
  ),
  active_prompt_outbox_idempotency_key TEXT NULL,
  draft_revision BIGINT NULL CHECK (draft_revision IS NULL OR draft_revision >= 0),
  last_inbox_message_id UUID NULL,
  flow_version INTEGER NOT NULL DEFAULT 2 CHECK (flow_version = 2),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_registration_conversations_active_prompt
  ON registration_conversations(active_prompt_outbox_idempotency_key)
  WHERE active_prompt_outbox_idempotency_key IS NOT NULL;
