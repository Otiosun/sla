-- 0039_public_verification_rate_limit.sql
-- Durable abuse protection for the read-only public Trainer Card verification surface.
-- Raw peer addresses and public IDs are never persisted; only keyed HMAC digests are stored.

CREATE TABLE public_verification_rate_limit_buckets (
  peer_hash TEXT NOT NULL
    CHECK (peer_hash ~ '^[0-9a-f]{64}$'),
  target_hash TEXT NOT NULL
    CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL
    CHECK (request_count > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (peer_hash, target_hash)
);

CREATE INDEX idx_public_verification_rate_limit_updated
  ON public_verification_rate_limit_buckets(updated_at);

COMMENT ON TABLE public_verification_rate_limit_buckets IS
  'Keyed-HMAC scoped public verification rate-limit buckets. Contains no raw peer address or Trainer Card public ID.';
