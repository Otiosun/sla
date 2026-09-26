import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  PlayerActivationAnnouncementInput,
  PlayerActivationAnnouncementPort,
} from "../../modules/registration/provisioning-announcement.js";
import { playerActivationAnnouncementIdempotencyKey } from "../../modules/registration/provisioning-announcement.js";
import { withTransaction } from "../db/transaction.js";

export class PostgresReceptionActivationAnnouncement implements PlayerActivationAnnouncementPort {
  public constructor(private readonly pool: Pool) {}

  public async enqueueActivated(input: PlayerActivationAnnouncementInput): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const groups = await client.query<{ id: string; chat_ref: string }>(
        `SELECT DISTINCT reception.id, reception.chat_ref
         FROM outbox_messages review_notification
         JOIN community_groups reception
           ON reception.chat_ref = review_notification.destination_ref
          AND reception.role = 'RECEPTION'
          AND reception.status = 'ACTIVE'
         WHERE review_notification.channel = 'whatsapp'
           AND review_notification.payload #>> '{registrationReview,reviewId}' = $1
         ORDER BY reception.id`,
        [input.reviewId],
      );
      if (groups.rows.length === 0) {
        throw new Error("Registration review has no active source Reception group");
      }

      for (const group of groups.rows) {
        const idempotencyKey = playerActivationAnnouncementIdempotencyKey(input.reviewId, group.id);
        const payload = {
          text: `〔⚡〕 𝗥𝗢𝗧𝗢𝗠𝗗𝗘𝗫\n*REGISTRO VALIDADO*\n\n\`TRAINER STATUS: ACTIVE\`\n\n*${input.trainerName}*, pronto! Sua ficha foi aprovada e seu acesso ao RPG está liberado, roto.\n\n🎁 Kit inicial: *₽2.000 + 5 Poké Balls*\n\n> Cadastro concluído. Esta Recepção permanece dedicada apenas a registros e revisões.`,
          registrationActivation: {
            reviewId: input.reviewId,
            playerId: input.playerId,
          },
        };
        const inserted = await client.query(
          `INSERT INTO outbox_messages(
             id, channel, destination_ref, message_type, payload, idempotency_key,
             status, attempts, next_attempt_at, correlation_id, causation_id
           ) VALUES ($1, 'whatsapp', $2, 'TEXT', $3::jsonb, $4,
                     'PENDING', 0, now(), $5, NULL)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [randomUUID(), group.chat_ref, JSON.stringify(payload), idempotencyKey, input.reviewId],
        );
        if (inserted.rowCount === 1) continue;

        const existing = await client.query<{ same: boolean }>(
          `SELECT channel = 'whatsapp'
                  AND destination_ref = $2
                  AND message_type = 'TEXT'
                  AND payload = $3::jsonb
                  AND correlation_id = $4::uuid
                  AND causation_id IS NULL AS same
           FROM outbox_messages
           WHERE idempotency_key = $1`,
          [idempotencyKey, group.chat_ref, JSON.stringify(payload), input.reviewId],
        );
        if (existing.rows[0]?.same !== true) {
          throw new Error("Reception activation announcement idempotency conflict");
        }
      }
    });
  }
}
