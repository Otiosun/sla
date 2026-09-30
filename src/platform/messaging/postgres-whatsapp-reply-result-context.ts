import type { Pool } from "pg";

export interface WhatsAppReplyResultContext {
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
  readonly mentions: readonly string[];
}

export interface WhatsAppReplyResultContextResolver {
  resolve(input: {
    readonly provider: string;
    readonly chatRef: string;
    readonly externalMessageId: string;
  }): Promise<WhatsAppReplyResultContext | null>;
}

function stringMentions(payload: unknown): readonly string[] {
  if (typeof payload !== "object" || payload === null || !("mentions" in payload)) return [];
  const value = (payload as { readonly mentions?: unknown }).mentions;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

/**
 * Baileys outbound message ids are deterministic compact UUIDs derived from outbox_messages.id.
 * Resolve replies back through the originating inbox result instead of guessing from recency.
 */
export class PostgresWhatsAppReplyResultContextResolver
  implements WhatsAppReplyResultContextResolver
{
  public constructor(private readonly pool: Pool) {}

  public async resolve(input: {
    readonly provider: string;
    readonly chatRef: string;
    readonly externalMessageId: string;
  }): Promise<WhatsAppReplyResultContext | null> {
    const externalId = input.externalMessageId.trim();

    const result = await this.pool.query<{
      result_ref_type: string | null;
      result_ref_id: string | null;
      payload: unknown;
    }>(
      `WITH replied_inbox AS (
         SELECT inbox.result_ref_type,
                inbox.result_ref_id,
                inbox.normalized_payload AS payload,
                0 AS priority
         FROM inbox_messages inbox
         WHERE inbox.provider = $1
           AND inbox.external_message_id = $2
           AND inbox.normalized_payload->>'chatRef' = $3
           AND inbox.status = 'PROCESSED'
           AND inbox.result_ref_type IS NOT NULL
         LIMIT 1
       ),
       replied_outbox AS (
         SELECT inbox.result_ref_type,
                inbox.result_ref_id,
                outbox.payload,
                1 AS priority
         FROM outbox_messages outbox
         JOIN inbox_messages inbox ON inbox.id = outbox.causation_id
         WHERE outbox.channel = 'whatsapp'
           AND outbox.destination_ref = $3
           AND upper(replace(outbox.id::text, '-', '')) = upper($2)
           AND inbox.result_ref_type IS NOT NULL
         LIMIT 1
       )
       SELECT result_ref_type, result_ref_id, payload
       FROM (
         SELECT * FROM replied_inbox
         UNION ALL
         SELECT * FROM replied_outbox
       ) resolved
       ORDER BY priority
       LIMIT 1`,
      [input.provider, externalId, input.chatRef],
    );

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      resultRefType: row.result_ref_type,
      resultRefId: row.result_ref_id,
      mentions: stringMentions(row.payload),
    };
  }
}
