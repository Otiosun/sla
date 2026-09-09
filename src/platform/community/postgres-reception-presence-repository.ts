import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  ReceptionMembershipInput,
  ReceptionMembershipMessage,
} from "../../modules/community/reception-membership.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

export interface ClaimReceptionFirstWelcomeInput {
  readonly groupId: string;
  readonly playerId: PlayerId;
}

export class PostgresReceptionPresenceRepository {
  public constructor(private readonly pool: Pool) {}

  public async recordMembership(
    input: ReceptionMembershipInput,
    welcome: () => Promise<ReceptionMembershipMessage>,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `reception-membership:${input.groupId}:${input.playerId}`,
      ]);
      const state = await client.query<{ presence_generation: string; present: boolean }>(
        `SELECT presence_generation::text,
          last_joined_at IS NOT NULL AND (last_left_at IS NULL OR last_joined_at > last_left_at) AS present
         FROM community_member_presence WHERE group_id=$1 AND player_id=$2 FOR UPDATE`,
        [input.groupId, input.playerId],
      );
      const previous = state.rows[0];
      if (input.action === "remove") {
        await client.query(
          `UPDATE community_member_presence SET last_left_at=clock_timestamp(), last_seen_at=clock_timestamp()
          WHERE group_id=$1 AND player_id=$2 AND (last_left_at IS NULL OR last_joined_at > last_left_at)`,
          [input.groupId, input.playerId],
        );
        return;
      }
      if (previous?.present) return;
      const generation = (BigInt(previous?.presence_generation ?? "0") + 1n).toString();
      const message = await welcome();
      await client.query(
        `INSERT INTO community_member_presence(group_id, player_id, presence_generation, last_joined_at, last_welcome_at)
        VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp())
        ON CONFLICT (group_id,player_id) DO UPDATE SET presence_generation=$3,
          last_joined_at=clock_timestamp(), last_seen_at=clock_timestamp(), last_welcome_at=clock_timestamp()`,
        [input.groupId, input.playerId, generation],
      );
      await client.query(
        `INSERT INTO outbox_messages(id,channel,destination_ref,message_type,payload,idempotency_key,status,attempts,next_attempt_at,correlation_id,causation_id)
        VALUES ($1,'whatsapp',$2,$3,$4::jsonb,$5,'PENDING',0,now(),$6,NULL)`,
        [
          randomUUID(),
          input.chatRef,
          message.messageType,
          JSON.stringify(message.payload),
          `reception:join:${input.groupId}:${input.playerId}:${generation}`,
          randomUUID(),
        ],
      );
    });
  }

  public async needsFirstWelcome(input: ClaimReceptionFirstWelcomeInput): Promise<boolean> {
    const result = await this.pool.query<{ needs_welcome: boolean }>(
      `SELECT last_welcome_at IS NULL AS needs_welcome
       FROM community_member_presence
       WHERE group_id = $1 AND player_id = $2`,
      [input.groupId, input.playerId],
    );
    return result.rows[0]?.needs_welcome ?? true;
  }

  public async claimFirstWelcome(input: ClaimReceptionFirstWelcomeInput): Promise<boolean> {
    const result = await this.pool.query<{ claimed: number }>(
      `INSERT INTO community_member_presence(
         group_id,
         player_id,
         presence_generation,
         first_seen_at,
         last_seen_at,
         last_welcome_at
       )
       VALUES ($1, $2, 0, now(), now(), now())
       ON CONFLICT (group_id, player_id) DO UPDATE
       SET last_seen_at = now(),
           last_welcome_at = now()
       WHERE community_member_presence.last_welcome_at IS NULL
       RETURNING 1 AS claimed`,
      [input.groupId, input.playerId],
    );
    return result.rows[0]?.claimed === 1;
  }
}
