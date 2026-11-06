-- INERT CANDIDATE. Trade confirmation and economy ledgers share one transaction.
CREATE TABLE world_service_mart_trade_receipts (
  player_id UUID NOT NULL REFERENCES players(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  session_id UUID NOT NULL REFERENCES world_service_sessions(id),
  session_revision BIGINT NOT NULL CHECK (session_revision>=0),
  kind TEXT NOT NULL CHECK (kind IN ('PURCHASE','SALE')),
  response_text TEXT NOT NULL CHECK (length(response_text) BETWEEN 1 AND 4096),
  PRIMARY KEY(player_id,idempotency_key)
);
