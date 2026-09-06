import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { RegistrationReplyIntentVerifier } from "../../modules/registration/conversation-resolver.js";

function baileysMessageIdForOutboxId(outboxMessageId: string): string {
  const compactUuid = outboxMessageId.replaceAll("-", "").toUpperCase();
  if (/^[0-9A-F]{32}$/.test(compactUuid)) return compactUuid;

  return createHash("sha256")
    .update(`pokemon-rpg:baileys:${outboxMessageId}`)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
}

export class PostgresRegistrationReplyIntentVerifier implements RegistrationReplyIntentVerifier {
  public constructor(private readonly pool: Pool) {}

  public async isExpectedReply(input: {
    readonly provider: string;
    readonly chatRef: string;
    readonly replyToExternalMessageId: string;
    readonly expectedOutboxIdempotencyKey: string;
  }): Promise<boolean> {
    if (input.provider !== "baileys") return false;

    const result = await this.pool.query<{ id: string }>(
      `SELECT id
       FROM outbox_messages
       WHERE idempotency_key = $1
         AND channel = 'whatsapp'
         AND destination_ref = $2
         AND status = 'SENT'
       LIMIT 1`,
      [input.expectedOutboxIdempotencyKey, input.chatRef],
    );
    const row = result.rows[0];
    if (row === undefined) return false;

    return baileysMessageIdForOutboxId(row.id) === input.replyToExternalMessageId;
  }
}
