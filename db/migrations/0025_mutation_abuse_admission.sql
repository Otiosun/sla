-- 0025_mutation_abuse_admission.sql
-- Phase 16.15: adapter-neutral durable anti-abuse admission for external mutable surfaces.

CREATE TABLE mutation_rate_limit_buckets (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('PLAYER', 'ADMIN_PRINCIPAL')),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  surface TEXT NOT NULL CHECK (surface IN ('CAPTURE', 'BATTLE', 'ECONOMY', 'ADMIN')),
  policy_key TEXT NOT NULL CHECK (length(policy_key) BETWEEN 1 AND 128),
  window_started_at TIMESTAMPTZ NOT NULL,
  used INTEGER NOT NULL CHECK (used > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_hash, surface, policy_key)
);

CREATE INDEX idx_mutation_rate_limit_buckets_updated
  ON mutation_rate_limit_buckets(updated_at);

CREATE TABLE mutation_rate_limit_charges (
  id UUID PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('PLAYER', 'ADMIN_PRINCIPAL')),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  surface TEXT NOT NULL CHECK (surface IN ('CAPTURE', 'BATTLE', 'ECONOMY', 'ADMIN')),
  policy_key TEXT NOT NULL CHECK (length(policy_key) BETWEEN 1 AND 128),
  action_key TEXT NOT NULL CHECK (length(action_key) BETWEEN 1 AND 128),
  dedupe_hash TEXT NOT NULL CHECK (dedupe_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  window_started_at TIMESTAMPTZ NOT NULL,
  charged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_hash, surface, policy_key, dedupe_hash)
);

CREATE INDEX idx_mutation_rate_limit_charges_subject
  ON mutation_rate_limit_charges(subject_kind, subject_hash, surface, charged_at DESC);

COMMENT ON TABLE mutation_rate_limit_buckets IS
  'Durable adapter-neutral budgets for externally exposed mutable Capture/Battle/Economy/Admin surfaces. Raw subject identifiers are never persisted.';

COMMENT ON TABLE mutation_rate_limit_charges IS
  'Append-only admission evidence. Exact idempotent replays reuse the prior charge; semantic drift on the same dedupe key fails closed and never reaches the domain owner.';
