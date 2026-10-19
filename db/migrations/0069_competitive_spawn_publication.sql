-- 0069_competitive_spawn_publication.sql
-- Competitive spawns become guessable only after the image outbox is confirmed SENT.
-- Unpublished technical failures remain cancellable without spending the activity cycle/cooldown.

ALTER TABLE competitive_spawns
  ADD COLUMN published_at TIMESTAMPTZ NULL;

ALTER TABLE competitive_spawns
  ADD CONSTRAINT competitive_spawns_publication_window
  CHECK (
    published_at IS NULL
    OR (
      published_at >= opened_at
      AND expires_at > published_at
    )
  );

ALTER TABLE competitive_spawns
  ADD CONSTRAINT competitive_spawns_resolved_publication
  CHECK (
    status NOT IN ('WON', 'EXPIRED')
    OR published_at IS NOT NULL
  );

CREATE INDEX idx_competitive_spawns_publication_pending
  ON competitive_spawns(status, published_at, opened_at)
  WHERE status = 'OPEN';
