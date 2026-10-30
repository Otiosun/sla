-- DRAFT ONLY: intentionally outside db/migrations.
-- PR #232 reserves 0076-0078. Do not include this SQL in production migration scans.
-- Used exclusively by disposable PostgreSQL integration tests until the
-- canonical migration sequence, runtime roles and release are reconciled.
CREATE TABLE solo_expeditions (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  period TEXT NOT NULL CHECK (period IN ('DAY', 'NIGHT')),
  area_id UUID NOT NULL REFERENCES areas(id),
  phase TEXT NOT NULL CHECK (phase IN ('PREPARING', 'ACTIVE', 'ENDED')),
  elapsed_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (elapsed_minutes BETWEEN 0 AND 720),
  consumed_week_key DATE NULL,
  end_reason TEXT NULL CHECK (
    end_reason IS NULL OR end_reason IN ('CANCELLED', 'VOLUNTARY', 'CLOCK', 'BLACKOUT')
  ),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    consumed_week_key IS NULL OR EXTRACT(ISODOW FROM consumed_week_key) = 1
  ),
  CONSTRAINT solo_expedition_phase_integrity CHECK (
    (phase = 'PREPARING' AND elapsed_minutes = 0
     AND consumed_week_key IS NULL AND end_reason IS NULL)
    OR
    (phase = 'ACTIVE' AND elapsed_minutes BETWEEN 1 AND 719
     AND consumed_week_key IS NOT NULL AND end_reason IS NULL)
    OR
    (phase = 'ENDED' AND (
      (end_reason = 'CANCELLED' AND elapsed_minutes = 0 AND consumed_week_key IS NULL)
      OR (end_reason IN ('VOLUNTARY', 'BLACKOUT')
          AND elapsed_minutes BETWEEN 1 AND 719 AND consumed_week_key IS NOT NULL)
      OR (end_reason = 'CLOCK' AND elapsed_minutes = 720 AND consumed_week_key IS NOT NULL)
    ))
  )
);

-- Prevent simultaneous preparations AND active expeditions for a trainer.
CREATE UNIQUE INDEX solo_expeditions_one_open_per_player
  ON solo_expeditions(player_id) WHERE phase <> 'ENDED';

CREATE INDEX solo_expeditions_weekly_consumption
  ON solo_expeditions(player_id, consumed_week_key)
  WHERE consumed_week_key IS NOT NULL;

-- A receipt survives later expedition state transitions and bot restarts.
-- The fingerprint binds a WhatsApp idempotency key to exactly one operation.
-- The JSON snapshot has revision serialized as a decimal string.
CREATE TABLE solo_expedition_receipts (
  player_id UUID NOT NULL REFERENCES players(id),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  expedition_id UUID NOT NULL REFERENCES solo_expeditions(id),
  operation TEXT NOT NULL CHECK (operation IN ('PREPARE', 'CHANGE_PERIOD', 'ADVANCE', 'END', 'ACTION_SEARCH_FREE')),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, idempotency_key)
);

COMMENT ON TABLE solo_expeditions IS
  'Draft V1.1 expedition lifecycle; no gameplay routes or live migrations.';
COMMENT ON TABLE solo_expedition_receipts IS
  'Immutable at-most-once transition outcomes bound to idempotency fingerprints.';


-- One durable search outcome per source expedition revision. This record and
-- its canonical encounter (when present), time, weekly quota and receipt all
-- belong to ONE caller-owned PostgreSQL transaction.
-- NO_SIGNAL and TRAIL carry no fake grants, inventory or encounter.
CREATE TABLE solo_expedition_search_outcomes (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  expedition_id UUID NOT NULL REFERENCES solo_expeditions(id),
  expedition_revision BIGINT NOT NULL CHECK (expedition_revision >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('NO_SIGNAL', 'TRAIL', 'INCIDENTAL', 'DIRECT')),
  encounter_id UUID NULL REFERENCES encounters(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT solo_search_encounter_requirements CHECK (
    (kind IN ('NO_SIGNAL', 'TRAIL') AND encounter_id IS NULL)
    OR (kind IN ('INCIDENTAL', 'DIRECT') AND encounter_id IS NOT NULL)
  ),
  UNIQUE(expedition_id, expedition_revision)
);
CREATE INDEX solo_search_outcomes_by_player
  ON solo_expedition_search_outcomes(player_id, expedition_id);
COMMENT ON TABLE solo_expedition_search_outcomes IS
  'Draft, not live. Outcome selection is server-side only; no loot or encounter invented by UI.';


-- A server-issued, immutable menu receipt. Repeated sends return the same
-- visible text and choice→item mapping; clients cannot submit arbitrary Ball
-- IDs and an old reply cannot silently adopt a new encounter menu.
-- Only the dispatcher (not a WhatsApp payload) may select the UUID menu ID.
CREATE TABLE solo_incidental_menu_snapshots (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  outcome_id UUID NOT NULL UNIQUE REFERENCES solo_expedition_search_outcomes(id),
  encounter_id UUID NOT NULL REFERENCES encounters(id),
  encounter_revision BIGINT NOT NULL CHECK (encounter_revision >= 0),
  panel JSONB NOT NULL CHECK (jsonb_typeof(panel)='object'),
  ball_item_ids JSONB NOT NULL CHECK (jsonb_typeof(ball_item_ids)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX solo_incidental_menus_by_player
  ON solo_incidental_menu_snapshots(player_id,created_at DESC);
COMMENT ON TABLE solo_incidental_menu_snapshots IS
  'Immutable server-issued V4 incidental menu and authorized Ball mappings. Draft only; WhatsApp binding and migration require separate release gate.';


-- Map the actual provider-delivered message to its server-issued menu. A
-- reply in a different chat or a different trainer must never reuse choices.
-- Binding occurs only after a trusted transport confirms delivery; it does
-- not send messages or alter inbox/outbox.
CREATE TABLE solo_incidental_menu_deliveries (
  id UUID PRIMARY KEY,
  menu_id UUID NOT NULL REFERENCES solo_incidental_menu_snapshots(id),
  player_id UUID NOT NULL REFERENCES players(id),
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 30),
  chat_ref TEXT NOT NULL CHECK (char_length(chat_ref) BETWEEN 1 AND 256),
  external_message_id TEXT NOT NULL CHECK (char_length(external_message_id) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider,chat_ref,external_message_id)
);
CREATE INDEX solo_incidental_menu_deliveries_by_player
  ON solo_incidental_menu_deliveries(player_id,menu_id);
COMMENT ON TABLE solo_incidental_menu_deliveries IS
  'Draft only: provider response-to message binding, not a WhatsApp sender authorization.';
