-- 0059_admin_batch_whatsapp_preview_refs.sql
-- Durable WhatsApp confirmation anchors for audited admin batch previews.

CREATE TABLE admin_batch_whatsapp_preview_refs (
  provider TEXT NOT NULL,
  provider_external_message_id TEXT NOT NULL,
  outbox_message_id UUID NOT NULL UNIQUE REFERENCES outbox_messages(id) ON DELETE CASCADE,
  admin_principal_id UUID NOT NULL REFERENCES admin_principals(id),
  chat_ref TEXT NOT NULL,
  batch_id UUID NOT NULL REFERENCES admin_batches(id) ON DELETE CASCADE,
  batch_revision BIGINT NOT NULL CHECK (batch_revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_external_message_id)
);

CREATE INDEX idx_admin_batch_whatsapp_preview_refs_batch
  ON admin_batch_whatsapp_preview_refs(batch_id, created_at DESC);

CREATE INDEX idx_admin_batch_whatsapp_preview_refs_principal
  ON admin_batch_whatsapp_preview_refs(admin_principal_id, created_at DESC);


CREATE OR REPLACE FUNCTION guard_admin_batch_whatsapp_preview_ref_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin batch WhatsApp preview refs are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_admin_batch_whatsapp_preview_ref_immutable
BEFORE UPDATE OR DELETE ON admin_batch_whatsapp_preview_refs
FOR EACH ROW EXECUTE FUNCTION guard_admin_batch_whatsapp_preview_ref_immutable();
