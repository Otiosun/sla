import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  CompetitiveSpawnRewardRecoveryIntent,
  CompetitiveSpawnRewardRecoveryRepository,
} from "../../modules/competitive-spawn/reward-recovery.js";
import { withTransaction } from "../db/transaction.js";

interface RewardRecoveryRow {
  readonly spawn_id: string;
  readonly player_id: string;
  readonly correlation_id: string;
  readonly reward_kind: "MONEY" | "ITEM" | "PROGRESSION";
  readonly reward_amount: string;
  readonly currency_id: string | null;
  readonly item_id: string | null;
  readonly display_name: string;
  readonly attempts: number;
}

function mapped(row: RewardRecoveryRow): CompetitiveSpawnRewardRecoveryIntent {
  const amount = Number(row.reward_amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Competitive reward recovery amount is invalid");
  }
  return {
    spawnId: row.spawn_id,
    playerId: row.player_id,
    correlationId: row.correlation_id,
    reward: {
      kind: row.reward_kind,
      amount,
      currencyId: row.currency_id,
      itemId: row.item_id,
      displayName: row.display_name,
    },
    attempts: row.attempts,
  };
}

function mentionToken(senderRef: string): string | null {
  if (senderRef.endsWith("@s.whatsapp.net")) return senderRef.slice(0, -15);
  if (senderRef.endsWith("@lid")) return senderRef.slice(0, -4);
  return null;
}

export class PostgresCompetitiveSpawnRewardRecoveryRepository
  implements CompetitiveSpawnRewardRecoveryRepository
{
  public constructor(private readonly pool: Pool) {}

  public async claimPending(input: {
    readonly now: Date;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly CompetitiveSpawnRewardRecoveryIntent[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) return [];
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error("Competitive reward recovery lease must be positive");
    }

    // One CTE performs the lock, lease claim and returned intent atomically.
    // No explicit PoolClient transaction is required for this single statement.
    const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
    const result = await this.pool.query<RewardRecoveryRow>(
      `WITH due AS (
         SELECT delivery.spawn_id
         FROM competitive_spawn_reward_deliveries delivery
         WHERE (
             delivery.status = 'PENDING'
             AND delivery.next_attempt_at <= $1
           )
           OR (
             delivery.status = 'APPLYING'
             AND delivery.lease_expires_at IS NOT NULL
             AND delivery.lease_expires_at <= $1
           )
         ORDER BY delivery.created_at, delivery.spawn_id
         LIMIT $2
         FOR UPDATE OF delivery SKIP LOCKED
       ),
       claimed AS (
         UPDATE competitive_spawn_reward_deliveries delivery
         SET status = 'APPLYING',
             attempts = delivery.attempts + 1,
             lease_expires_at = $3,
             last_error = NULL,
             updated_at = $1
         FROM due
         WHERE delivery.spawn_id = due.spawn_id
         RETURNING delivery.spawn_id, delivery.attempts
       )
       SELECT claimed.spawn_id,
              intent.player_id,
              intent.correlation_id,
              intent.reward_kind,
              intent.reward_amount::text,
              intent.currency_id,
              intent.item_id,
              intent.display_name,
              claimed.attempts
       FROM claimed
       JOIN competitive_spawn_reward_intents intent ON intent.spawn_id = claimed.spawn_id`,
      [input.now, input.limit, leaseUntil],
    );
    return result.rows.map(mapped);
  }

  public async markApplied(spawnId: string, now: Date): Promise<void> {
    const result = await this.pool.query(
      `UPDATE competitive_spawn_reward_deliveries
       SET status = 'APPLIED',
           applied_at = COALESCE(applied_at, $2),
           lease_expires_at = NULL,
           next_attempt_at = $2,
           last_error = NULL,
           updated_at = $2
       WHERE spawn_id = $1
         AND status IN ('PENDING', 'APPLYING', 'APPLIED')`,
      [spawnId, now],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error("Competitive reward delivery could not be marked APPLIED");
    }
  }

  public async markFailed(input: {
    readonly spawnId: string;
    readonly now: Date;
    readonly errorCode: string;
    readonly retryAt: Date | null;
    readonly maxAttempts: number;
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE competitive_spawn_reward_deliveries
       SET status = CASE
             WHEN attempts >= $4 OR $3::timestamptz IS NULL THEN 'FAILED'
             ELSE 'PENDING'
           END,
           next_attempt_at = COALESCE($3, $2),
           lease_expires_at = NULL,
           last_error = $5,
           updated_at = $2
       WHERE spawn_id = $1
         AND status = 'APPLYING'`,
      [input.spawnId, input.now, input.retryAt, input.maxAttempts, input.errorCode],
    );
    if ((result.rowCount ?? 0) !== 1) {
      const current = await this.pool.query<{ status: string }>(
        "SELECT status FROM competitive_spawn_reward_deliveries WHERE spawn_id = $1",
        [input.spawnId],
      );
      if (current.rows[0]?.status === "APPLIED") return;
      throw new Error("Competitive reward delivery failure state could not be persisted");
    }
  }

  public async projectAppliedWinners(limit: number, now: Date): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return 0;

    // Cheap read avoids opening a transaction when there is nothing to project.
    // This also keeps maintenance composition unit-testable with its deliberate query-only Pool stub.
    const due = await this.pool.query<{ spawn_id: string }>(
      `SELECT spawn_id
       FROM competitive_spawn_reward_deliveries
       WHERE status = 'APPLIED'
         AND notification_projected_at IS NULL
       ORDER BY created_at, spawn_id
       LIMIT 1`,
    );
    if (due.rows[0] === undefined) return 0;

    return withTransaction(this.pool, async (client) => {
      const rows = await client.query<{
        spawn_id: string;
        chat_ref: string;
        species_display_name: string;
        shiny: boolean;
        trainer_name: string | null;
        sender_ref: string;
        reward_display_name: string;
        pokemon_bonus: boolean;
        correlation_id: string;
        winning_inbox_message_id: string;
      }>(
        `SELECT intent.spawn_id,
                spawn.chat_ref,
                spawn.species_display_name,
                spawn.shiny,
                profile.trainer_name,
                attempt.sender_ref,
                intent.display_name AS reward_display_name,
                intent.pokemon_bonus,
                intent.correlation_id,
                spawn.winning_inbox_message_id
         FROM competitive_spawn_reward_deliveries delivery
         JOIN competitive_spawn_reward_intents intent ON intent.spawn_id = delivery.spawn_id
         JOIN competitive_spawns spawn ON spawn.id = delivery.spawn_id
         JOIN inbox_messages inbox
           ON inbox.id = spawn.winning_inbox_message_id
          AND inbox.status IN ('PROCESSED', 'FAILED')
         JOIN competitive_spawn_attempts attempt
           ON attempt.inbox_message_id = spawn.winning_inbox_message_id
          AND attempt.correct = TRUE
         LEFT JOIN player_profiles profile ON profile.player_id = intent.player_id
         WHERE delivery.status = 'APPLIED'
           AND delivery.notification_projected_at IS NULL
         ORDER BY delivery.created_at, delivery.spawn_id
         LIMIT $1
         FOR UPDATE OF delivery SKIP LOCKED`,
        [limit],
      );

      let projected = 0;
      for (const row of rows.rows) {
        const mention = mentionToken(row.sender_ref);
        const display = mention === null ? (row.trainer_name ?? "Treinador") : `@${mention}`;
        const bonusLine = row.pokemon_bonus
          ? `Bônus Pokémon · \`${row.species_display_name}${row.shiny ? " ✨" : ""}\``
          : null;
        const text = [
          "◇ *𝗜𝗗𝗘𝗡𝗧𝗜𝗙𝗜𝗖𝗔𝗗𝗢*",
          `　${display}`,
          "",
          `*${row.species_display_name}* · \`+1 avistamento\``,
          `Recompensa · \`${row.reward_display_name}\``,
          ...(bonusLine === null ? [] : [bonusLine]),
        ].join("\n");
        const payload = {
          text,
          ...(mention === null ? {} : { mentions: [row.sender_ref] }),
        };
        const idempotencyKey = `competitive-spawn:${row.spawn_id}:winner`;

        const inserted = await client.query(
          `INSERT INTO outbox_messages(
             id, channel, destination_ref, message_type, payload, idempotency_key,
             status, attempts, next_attempt_at, correlation_id, causation_id, sequence_no
           ) VALUES (
             $1, 'whatsapp', $2, 'TEXT', $3::jsonb, $4,
             'PENDING', 0, $5, $6, $7, 0
           )
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            randomUUID(),
            row.chat_ref,
            JSON.stringify(payload),
            idempotencyKey,
            now,
            row.correlation_id,
            row.winning_inbox_message_id,
          ],
        );

        if ((inserted.rowCount ?? 0) === 0) {
          const existing = await client.query<{ same: boolean }>(
            `SELECT channel = 'whatsapp'
                    AND destination_ref = $2
                    AND message_type = 'TEXT'
                    AND payload = $3::jsonb
                    AND correlation_id = $4::uuid
                    AND causation_id = $5::uuid AS same
             FROM outbox_messages
             WHERE idempotency_key = $1`,
            [
              idempotencyKey,
              row.chat_ref,
              JSON.stringify(payload),
              row.correlation_id,
              row.winning_inbox_message_id,
            ],
          );
          if (existing.rows[0]?.same !== true) {
            throw new Error("Competitive winner outbox idempotency conflict");
          }
        }

        await client.query(
          `UPDATE competitive_spawn_reward_deliveries
           SET notification_projected_at = COALESCE(notification_projected_at, $2),
               updated_at = $2
           WHERE spawn_id = $1`,
          [row.spawn_id, now],
        );
        projected += 1;
      }

      return projected;
    });
  }
}
