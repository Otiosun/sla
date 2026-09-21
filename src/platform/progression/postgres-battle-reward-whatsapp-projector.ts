import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type BattleRewardResult,
  BattleRewardResultSchema,
} from "../../modules/progression/contracts.js";
import { withTransaction } from "../db/transaction.js";

interface InternalRewardRow {
  readonly id: string;
  readonly payload: unknown;
  readonly correlation_id: string;
}

interface RewardDestination {
  readonly chat_ref: string;
  readonly external_id: string;
}

export interface BattleRewardWhatsAppProjectionResult {
  readonly claimed: number;
  readonly projected: number;
  readonly deferred: number;
}

function trainerLine(result: BattleRewardResult): string {
  const level =
    result.trainer.afterLevel > result.trainer.beforeLevel
      ? ` · Nv. ${result.trainer.beforeLevel} → ${result.trainer.afterLevel}`
      : "";
  return `🏅 Treinador: +${result.trainer.pointsGained} XP${level}`;
}

function pokemonLines(result: BattleRewardResult): readonly string[] {
  return result.pokemon.flatMap((pokemon, index) => {
    const level =
      pokemon.afterLevel > pokemon.beforeLevel
        ? ` · Nv. ${pokemon.beforeLevel} → ${pokemon.afterLevel}`
        : "";
    const lines = [`⚡ Pokémon ${index + 1}: +${pokemon.awardedXp} XP${level}`];
    if (pokemon.pendingMoveChoiceIds.length > 0) {
      lines.push(
        `⚠️ ${pokemon.pendingMoveChoiceIds.length} novo golpe aguarda escolha antes de substituir um slot.`,
      );
    }
    if (pokemon.evolutions.length > 0) {
      lines.push(`✨ Evoluções aplicadas: ${pokemon.evolutions.length}.`);
    }
    return lines;
  });
}

function rewardText(result: BattleRewardResult, senderRef: string): string {
  const handle = senderRef.endsWith("@s.whatsapp.net") ? senderRef.split("@")[0] : senderRef;
  return [
    "✨ *RECOMPENSA DE BATALHA*",
    "",
    `@${handle}, a vitória foi registrada.`,
    "",
    trainerLine(result),
    ...pokemonLines(result),
    ...(result.trainer.unlockKeys.length === 0
      ? []
      : [`🔓 Desbloqueios: ${result.trainer.unlockKeys.join(", ")}`]),
  ].join("\n");
}

async function resolveDestination(
  client: PoolClient,
  reward: BattleRewardResult,
): Promise<RewardDestination | null> {
  const result = await client.query<RewardDestination>(
    `SELECT inbox.normalized_payload->>'chatRef' AS chat_ref,
            identity.external_id
     FROM inbox_messages inbox
     JOIN community_groups community
       ON community.chat_ref=inbox.normalized_payload->>'chatRef'
      AND community.status='ACTIVE'
     JOIN player_identities identity
       ON identity.player_id=$2
      AND identity.provider='baileys'
      AND identity.status='ACTIVE'
     WHERE inbox.status='PROCESSED'
       AND inbox.player_id=$2
       AND inbox.result_ref_type='BATTLE'
       AND inbox.result_ref_id=$1
       AND inbox.normalized_payload->>'provider'='baileys'
     ORDER BY inbox.processed_at DESC NULLS LAST,inbox.received_at DESC,inbox.id DESC
     LIMIT 1`,
    [reward.battleId, reward.playerId],
  );
  return result.rows[0] ?? null;
}

export class PostgresBattleRewardWhatsAppProjector {
  public constructor(private readonly pool: Pool) {}

  public async runOnce(limit: number): Promise<BattleRewardWhatsAppProjectionResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Battle reward WhatsApp projection limit must be a positive safe integer");
    }

    return withTransaction(this.pool, async (client) => {
      const pending = await client.query<InternalRewardRow>(
        `SELECT id,payload,correlation_id
         FROM outbox_messages
         WHERE channel='INTERNAL'
           AND message_type='BATTLE_REWARD_RESULT'
           AND status='PENDING'
         ORDER BY created_at,id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );

      let projected = 0;
      let deferred = 0;
      for (const row of pending.rows) {
        const reward = BattleRewardResultSchema.parse(row.payload);
        const destination = await resolveDestination(client, reward);
        if (destination === null) {
          deferred += 1;
          continue;
        }

        const payload = {
          text: rewardText(reward, destination.external_id),
          mentions: [destination.external_id],
          battleReward: {
            battleId: reward.battleId,
            playerId: reward.playerId,
          },
        };
        const idempotencyKey = `progression.reward-whatsapp:${reward.battleId}`;
        const inserted = await client.query(
          `INSERT INTO outbox_messages(
             id,channel,destination_ref,message_type,payload,idempotency_key,
             status,attempts,next_attempt_at,correlation_id,causation_id
           ) VALUES ($1,'whatsapp',$2,'TEXT',$3::jsonb,$4,'PENDING',0,now(),$5,NULL)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            randomUUID(),
            destination.chat_ref,
            JSON.stringify(payload),
            idempotencyKey,
            row.correlation_id,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await client.query<{ same: boolean }>(
            `SELECT channel='whatsapp'
                    AND destination_ref=$2
                    AND message_type='TEXT'
                    AND payload=$3::jsonb
                    AND correlation_id=$4::uuid AS same
             FROM outbox_messages
             WHERE idempotency_key=$1`,
            [idempotencyKey, destination.chat_ref, JSON.stringify(payload), row.correlation_id],
          );
          if (existing.rows[0]?.same !== true) {
            throw new Error("Battle reward WhatsApp projection idempotency conflict");
          }
        }

        await client.query(
          `UPDATE outbox_messages
           SET status='SENT',sent_at=COALESCE(sent_at,now()),next_attempt_at=NULL
           WHERE id=$1 AND channel='INTERNAL' AND status='PENDING'`,
          [row.id],
        );
        projected += 1;
      }

      return { claimed: pending.rows.length, projected, deferred };
    });
  }
}
