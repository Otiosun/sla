import type { Pool } from "pg";
import type { PlayerProvisioningCandidateSource } from "../../modules/registration/provisioning-worker.js";

export class PostgresProvisioningCandidateSource implements PlayerProvisioningCandidateSource {
  public constructor(private readonly pool: Pool) {}

  public async listPendingReviewIds(limit: number): Promise<readonly string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT revision.id
       FROM registration_revisions revision
       LEFT JOIN player_access access ON access.player_id = revision.player_id
       WHERE revision.status = 'APPROVED'
         AND NOT EXISTS (
           SELECT 1
           FROM registration_revisions newer
           WHERE newer.player_id = revision.player_id
             AND newer.sequence_no > revision.sequence_no
         )
         AND (
           access.player_id IS NULL
           OR access.status = 'PENDING'
           OR (
             access.approved_review_id = revision.id
             AND access.status = 'PROVISIONING'
           )
           OR (
             access.approved_review_id = revision.id
             AND access.status = 'ACTIVE'
             AND EXISTS (
               SELECT 1
               FROM community_groups reception
               WHERE reception.role = 'RECEPTION'
                 AND reception.status = 'ACTIVE'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM outbox_messages announcement
                   WHERE announcement.idempotency_key =
                     'registration-activated:' || revision.id::text || ':' || reception.id::text
                 )
             )
           )
         )
       ORDER BY revision.submitted_at, revision.id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }
}
