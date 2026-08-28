-- 0021_messaging_operational_hardening.sql
-- Phase 13.14-13.16: durable anti-spam, crash-safe rate-limit charges and async optional media.

CREATE TABLE messaging_rate_limit_buckets (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('PLAYER', 'CHAT', 'ACTION')),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  policy_key TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  used INTEGER NOT NULL CHECK (used > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_kind, subject_hash, policy_key)
);

CREATE INDEX idx_messaging_rate_limit_buckets_updated
  ON messaging_rate_limit_buckets(updated_at);

CREATE TABLE messaging_rate_limit_charges (
  inbox_message_id UUID NOT NULL REFERENCES inbox_messages(id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('PLAYER', 'CHAT', 'ACTION')),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  policy_key TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  charged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (inbox_message_id, scope_kind, policy_key)
);

CREATE INDEX idx_messaging_rate_limit_charges_subject
  ON messaging_rate_limit_charges(scope_kind, subject_hash, charged_at DESC);

CREATE TABLE messaging_media_jobs (
  id UUID PRIMARY KEY,
  inbox_message_id UUID NOT NULL REFERENCES inbox_messages(id),
  provider TEXT NOT NULL,
  provider_media_id TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'OTHER')),
  mime_type TEXT NULL,
  file_name TEXT NULL,
  processor_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NULL,
  processing_started_at TIMESTAMPTZ NULL,
  processed_at TIMESTAMPTZ NULL,
  last_error_code TEXT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inbox_message_id, provider_media_id, processor_key),
  CHECK ((status = 'PROCESSED' AND processed_at IS NOT NULL) OR status <> 'PROCESSED')
);

CREATE INDEX idx_messaging_media_jobs_claim
  ON messaging_media_jobs(status, next_attempt_at, created_at);
CREATE INDEX idx_messaging_media_jobs_recovery
  ON messaging_media_jobs(status, processing_started_at, created_at);

COMMENT ON TABLE messaging_rate_limit_charges IS
  'Append-only admission evidence. A recovered Inbox reuses its prior charge instead of consuming rate-limit budget twice.';
COMMENT ON TABLE messaging_media_jobs IS
  'Optional media work requested by a handler. Network/media processing happens only in MediaWorker after the mechanical handler transaction has finished.';
