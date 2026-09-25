import type { Pool } from "pg";

export interface AdminBatchWhatsAppPreviewRef {
  readonly provider: string;
  readonly providerExternalMessageId: string;
  readonly outboxMessageId: string;
  readonly adminPrincipalId: string;
  readonly chatRef: string;
  readonly batchId: string;
  readonly batchRevision: string;
}

interface RefRow {
  readonly provider: string;
  readonly provider_external_message_id: string;
  readonly outbox_message_id: string;
  readonly admin_principal_id: string;
  readonly chat_ref: string;
  readonly batch_id: string;
  readonly batch_revision: string;
}

function record(row: RefRow): AdminBatchWhatsAppPreviewRef {
  return {
    provider: row.provider,
    providerExternalMessageId: row.provider_external_message_id,
    outboxMessageId: row.outbox_message_id,
    adminPrincipalId: row.admin_principal_id,
    chatRef: row.chat_ref,
    batchId: row.batch_id,
    batchRevision: row.batch_revision,
  };
}

function same(left: AdminBatchWhatsAppPreviewRef, right: AdminBatchWhatsAppPreviewRef): boolean {
  return (
    left.provider === right.provider &&
    left.providerExternalMessageId === right.providerExternalMessageId &&
    left.outboxMessageId === right.outboxMessageId &&
    left.adminPrincipalId === right.adminPrincipalId &&
    left.chatRef === right.chatRef &&
    left.batchId === right.batchId &&
    left.batchRevision === right.batchRevision
  );
}

export class PostgresAdminBatchWhatsAppPreviewRefRepository {
  public constructor(private readonly pool: Pool) {}

  public async record(input: AdminBatchWhatsAppPreviewRef): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_batch_whatsapp_preview_refs(
         provider, provider_external_message_id, outbox_message_id, admin_principal_id,
         chat_ref, batch_id, batch_revision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        input.provider,
        input.providerExternalMessageId,
        input.outboxMessageId,
        input.adminPrincipalId,
        input.chatRef,
        input.batchId,
        input.batchRevision,
      ],
    );
    const stored = await this.findByProviderMessage({
      provider: input.provider,
      providerExternalMessageId: input.providerExternalMessageId,
    });
    if (stored === null || !same(stored, input)) {
      throw new Error("Admin batch WhatsApp preview ref conflicts with an existing mapping");
    }
  }

  public async findByProviderMessage(input: {
    readonly provider: string;
    readonly providerExternalMessageId: string;
  }): Promise<AdminBatchWhatsAppPreviewRef | null> {
    const result = await this.pool.query<RefRow>(
      `SELECT provider, provider_external_message_id, outbox_message_id,
              admin_principal_id, chat_ref, batch_id, batch_revision::text
       FROM admin_batch_whatsapp_preview_refs
       WHERE provider = $1 AND provider_external_message_id = $2`,
      [input.provider, input.providerExternalMessageId],
    );
    const row = result.rows[0];
    return row === undefined ? null : record(row);
  }
}
