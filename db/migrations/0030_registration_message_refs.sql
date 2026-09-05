-- 0030_registration_message_refs.sql
-- Reception/admin review v1: durable mapping from provider messages to exact registration reviews.
-- NOTE: reception migrations remain provisional until merge ordering is revalidated against main.

CREATE TABLE registration_message_refs (
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
  provider_external_message_id TEXT NOT NULL CHECK (
    char_length(provider_external_message_id) BETWEEN 1 AND 512
  ),
  outbox_message_id UUID NOT NULL REFERENCES outbox_messages(id) ON DELETE RESTRICT,
  review_id UUID NOT NULL REFERENCES registration_revisions(id) ON DELETE RESTRICT,
  review_revision BIGINT NOT NULL CHECK (review_revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_external_message_id),
  UNIQUE (outbox_message_id)
);

CREATE INDEX idx_registration_message_refs_review
  ON registration_message_refs(review_id, review_revision);

COMMENT ON TABLE registration_message_refs IS
  'Provider reply anchor for an exact registration review revision. Domain review state remains authoritative in registration_revisions.';
