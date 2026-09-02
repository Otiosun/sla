import type { Pool } from "pg";

export interface RegistrationMessageRef {
  readonly provider: string;
  readonly providerExternalMessageId: string;
  readonly outboxMessageId: string;
  readonly reviewId: string;
  readonly reviewRevision: number;
}

export interface RecordRegistrationMessageRef extends RegistrationMessageRef {}

interface RegistrationMessageRefRow {
  readonly provider: string;
  readonly provider_external_message_id: string;
  readonly outbox_message_id: string;
  readonly review_id: string;
  readonly review_revision: string;
}

function asRecord(row: RegistrationMessageRefRow): RegistrationMessageRef {
  return {
    provider: row.provider,
    providerExternalMessageId: row.provider_external_message_id,
    outboxMessageId: row.outbox_message_id,
    reviewId: row.review_id,
    reviewRevision: Number(row.review_revision),
  };
}

function sameRef(left: RegistrationMessageRef, right: RegistrationMessageRef): boolean {
  return (
    left.provider === right.provider &&
    left.providerExternalMessageId === right.providerExternalMessageId &&
    left.outboxMessageId === right.outboxMessageId &&
    left.reviewId === right.reviewId &&
    left.reviewRevision === right.reviewRevision
  );
}

export class PostgresRegistrationMessageRefRepository {
  public constructor(private readonly pool: Pool) {}

  public async record(input: RecordRegistrationMessageRef): Promise<void> {
    await this.pool.query(
      `INSERT INTO registration_message_refs(
         provider,
         provider_external_message_id,
         outbox_message_id,
         review_id,
         review_revision
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        input.provider,
        input.providerExternalMessageId,
        input.outboxMessageId,
        input.reviewId,
        input.reviewRevision,
      ],
    );

    const stored = await this.findByProviderMessage({
      provider: input.provider,
      providerExternalMessageId: input.providerExternalMessageId,
    });
    if (stored === null || !sameRef(stored, input)) {
      throw new Error("Registration message ref conflicts with an existing provider message mapping");
    }
  }

  public async findByProviderMessage(input: {
    readonly provider: string;
    readonly providerExternalMessageId: string;
  }): Promise<RegistrationMessageRef | null> {
    const result = await this.pool.query<RegistrationMessageRefRow>(
      `SELECT
         provider,
         provider_external_message_id,
         outbox_message_id,
         review_id,
         review_revision::text
       FROM registration_message_refs
       WHERE provider = $1 AND provider_external_message_id = $2`,
      [input.provider, input.providerExternalMessageId],
    );
    const row = result.rows[0];
    return row === undefined ? null : asRecord(row);
  }
}
