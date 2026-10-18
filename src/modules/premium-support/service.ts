import type { Pool } from "pg";
import { z } from "zod";

export const PremiumSupportNoteSchema = z.object({
  eventId: z.string().uuid(),
  orderId: z.string().uuid().nullable(),
  kind: z.enum(["NOTE", "REVIEW", "RESOLVED"]),
  body: z.string().trim().min(8).max(1400),
}).strict();

export type PremiumSupportNoteInput = z.infer<typeof PremiumSupportNoteSchema>;

interface PremiumSupportRow {
  id: string;
  player_id: string;
  order_id: string | null;
  actor_principal_id: string;
  kind: "NOTE" | "REVIEW" | "RESOLVED";
  body: string;
  created_at: Date;
}

export interface PremiumSupportEvent {
  readonly id: string;
  readonly playerId: string;
  readonly orderId: string | null;
  readonly actorPrincipalId: string;
  readonly kind: "NOTE" | "REVIEW" | "RESOLVED";
  readonly body: string;
  readonly createdAt: string;
}

function present(row: PremiumSupportRow): PremiumSupportEvent {
  return {
    id: row.id,
    playerId: row.player_id,
    orderId: row.order_id,
    actorPrincipalId: row.actor_principal_id,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

export class PremiumSupportService {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async list(playerId: string): Promise<readonly PremiumSupportEvent[]> {
    const result = await this.pool.query<PremiumSupportRow>(
      `SELECT id, player_id, order_id, actor_principal_id, kind, body, created_at
       FROM premium_support_events
       WHERE player_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      [playerId],
    );
    return result.rows.map(present);
  }

  public async append(
    playerId: string,
    actorPrincipalId: string,
    raw: unknown,
  ): Promise<{ event: PremiumSupportEvent; replayed: boolean } | null> {
    const input = PremiumSupportNoteSchema.parse(raw);
    // A client-controlled UUID is only an idempotency identifier; the backend
    // always binds the player and actor to the authenticated owner request.
    const result = await this.pool.query<PremiumSupportRow>(
      `INSERT INTO premium_support_events (
         id, player_id, order_id, actor_principal_id, kind, body
       )
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text
       WHERE EXISTS (SELECT 1 FROM players WHERE id = $2::uuid)
         AND ($3::uuid IS NULL OR EXISTS (
           SELECT 1 FROM premium_orders
           WHERE id = $3::uuid AND player_id = $2::uuid
         ))
       ON CONFLICT (id) DO NOTHING
       RETURNING id, player_id, order_id, actor_principal_id, kind, body, created_at`,
      [input.eventId, playerId, input.orderId, actorPrincipalId, input.kind, input.body],
    );
    const created = result.rows[0];
    if (created) return { event: present(created), replayed: false };

    const previous = await this.pool.query<PremiumSupportRow>(
      `SELECT id, player_id, order_id, actor_principal_id, kind, body, created_at
       FROM premium_support_events WHERE id = $1::uuid`,
      [input.eventId],
    );
    const existing = previous.rows[0];
    if (!existing) return null;
    if (
      existing.player_id !== playerId ||
      existing.order_id !== input.orderId ||
      existing.actor_principal_id !== actorPrincipalId ||
      existing.kind !== input.kind ||
      existing.body !== input.body
    ) {
      throw new Error("SUPPORT_IDEMPOTENCY_CONFLICT");
    }
    return { event: present(existing), replayed: true };
  }
}
