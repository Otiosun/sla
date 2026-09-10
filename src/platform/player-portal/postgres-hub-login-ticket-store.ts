import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ExternalIdentitySchema, type ExternalIdentity } from "../../modules/player/contracts.js";
import type {
  HubLoginTicketRecord,
  HubLoginTicketStore,
} from "../../modules/player-portal/login-ticket-service.js";

interface HubLoginTicketRow {
  readonly provider: string;
  readonly external_id: string;
  readonly expires_at: Date;
}

export class PostgresHubLoginTicketStore implements HubLoginTicketStore {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async issue(record: HubLoginTicketRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO hub_login_tickets (
          id,
          ticket_hash,
          provider,
          external_id,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        randomUUID(),
        record.ticketHash,
        record.identity.provider,
        record.identity.externalId,
        record.expiresAt,
      ],
    );
  }

  public async consume(input: {
    readonly ticketHash: string;
    readonly now: Date;
  }): Promise<ExternalIdentity | null> {
    const result = await this.pool.query<HubLoginTicketRow>(
      `
        DELETE FROM hub_login_tickets
        WHERE ticket_hash = $1
        RETURNING provider, external_id, expires_at
      `,
      [input.ticketHash],
    );

    const row = result.rows[0];
    if (row === undefined || row.expires_at.getTime() <= input.now.getTime()) {
      return null;
    }

    const identity = ExternalIdentitySchema.safeParse({
      provider: row.provider,
      externalId: row.external_id,
    });
    return identity.success ? identity.data : null;
  }
}