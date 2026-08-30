-- 0026_runtime_health_evidence.sql
-- Phase 17: durable, revision-bound operational evidence for the long-running WhatsApp runtime.

CREATE TABLE runtime_instances (
  instance_id UUID PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  deployment_revision TEXT NOT NULL CHECK (deployment_revision ~ '^[0-9a-f]{40}$'),
  whatsapp_session_key TEXT NOT NULL CHECK (whatsapp_session_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider_state TEXT NOT NULL CHECK (
    provider_state IN ('STARTING', 'CONNECTED', 'DISCONNECTED', 'STOPPED', 'INVALIDATED')
  ),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_connected_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_disconnect_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  shutdown_reason TEXT CHECK (shutdown_reason IS NULL OR length(shutdown_reason) BETWEEN 1 AND 128),
  CHECK (last_heartbeat_at >= started_at),
  CHECK (last_connected_at IS NULL OR last_connected_at >= started_at),
  CHECK (last_disconnect_at IS NULL OR last_disconnect_at >= started_at),
  CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  CHECK (
    (provider_state IN ('STOPPED', 'INVALIDATED') AND stopped_at IS NOT NULL)
    OR (provider_state NOT IN ('STOPPED', 'INVALIDATED') AND stopped_at IS NULL)
  )
);

CREATE INDEX idx_runtime_instances_smoke_lookup
  ON runtime_instances(environment, whatsapp_session_key, started_at DESC);

CREATE INDEX idx_runtime_instances_revision_lookup
  ON runtime_instances(deployment_revision, started_at DESC);

COMMENT ON TABLE runtime_instances IS
  'Durable per-process operational evidence for WhatsApp workers. Rows are preserved across restarts and bind provider state/heartbeat to environment, session key and exact deployment Git SHA.';
