import type { Pool, PoolClient } from "pg";
import type {
  ActivatePlayerAccessWrite,
  BeginPlayerProvisioningWrite,
  ChangePlayerAccessWrite,
  PlayerAccessRecord,
  PlayerAccessRepository,
  PlayerAccessStatus,
  PlayerAccessTransaction,
} from "../../modules/registration/player-access-ports.js";
import { type PlayerId, parsePlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

interface PlayerAccessRow {
  readonly player_id: string;
  readonly status: PlayerAccessStatus;
  readonly approved_review_id: string | null;
  readonly revision: string;
}

function asPlayerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function asRecord(row: PlayerAccessRow): PlayerAccessRecord {
  return {
    playerId: asPlayerId(row.player_id),
    status: row.status,
    approvedReviewId: row.approved_review_id,
    revision: Number(row.revision),
  };
}

function pendingRecord(playerId: PlayerId): PlayerAccessRecord {
  return { playerId, status: "PENDING", approvedReviewId: null, revision: 0 };
}

class PostgresPlayerAccessTransaction implements PlayerAccessTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async load(playerId: PlayerId): Promise<PlayerAccessRecord> {
    const result = await this.client.query<PlayerAccessRow>(
      `SELECT player_id, status, approved_review_id, revision::text
       FROM player_access
       WHERE player_id = $1`,
      [playerId],
    );
    const row = result.rows[0];
    return row === undefined ? pendingRecord(playerId) : asRecord(row);
  }

  public async beginProvisioning(
    input: BeginPlayerProvisioningWrite,
  ): Promise<PlayerAccessRecord | null> {
    if (input.expectedRevision === 0) {
      const inserted = await this.client.query<PlayerAccessRow>(
        `INSERT INTO player_access(
           player_id, status, approved_review_id, revision, created_at, updated_at
         ) VALUES ($1, 'PROVISIONING', $2, 1, now(), now())
         ON CONFLICT (player_id) DO NOTHING
         RETURNING player_id, status, approved_review_id, revision::text`,
        [input.playerId, input.reviewId],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) return asRecord(insertedRow);
    }

    const updated = await this.client.query<PlayerAccessRow>(
      `UPDATE player_access
       SET status = 'PROVISIONING',
           approved_review_id = $2,
           revision = revision + 1,
           suspended_reason = NULL,
           suspended_by = NULL,
           updated_at = now()
       WHERE player_id = $1
         AND status = 'PENDING'
         AND revision = $3
       RETURNING player_id, status, approved_review_id, revision::text`,
      [input.playerId, input.reviewId, input.expectedRevision],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow !== undefined) return asRecord(updatedRow);

    const current = await this.client.query<PlayerAccessRow>(
      `SELECT player_id, status, approved_review_id, revision::text
       FROM player_access
       WHERE player_id = $1
         AND status = 'PROVISIONING'
         AND approved_review_id = $2
         AND revision = $3`,
      [input.playerId, input.reviewId, input.expectedRevision],
    );
    const currentRow = current.rows[0];
    return currentRow === undefined ? null : asRecord(currentRow);
  }

  public async activate(input: ActivatePlayerAccessWrite): Promise<PlayerAccessRecord | null> {
    const result = await this.client.query<PlayerAccessRow>(
      `UPDATE player_access
       SET status = 'ACTIVE',
           revision = revision + 1,
           updated_at = now()
       WHERE player_id = $1
         AND status = 'PROVISIONING'
         AND approved_review_id = $2
         AND revision = $3
       RETURNING player_id, status, approved_review_id, revision::text`,
      [input.playerId, input.reviewId, input.expectedRevision],
    );
    const row = result.rows[0];
    return row === undefined ? null : asRecord(row);
  }

  public async suspend(input: ChangePlayerAccessWrite): Promise<PlayerAccessRecord | null> {
    const result = await this.client.query<PlayerAccessRow>(
      `UPDATE player_access
       SET status = 'SUSPENDED',
           revision = revision + 1,
           updated_at = now()
       WHERE player_id = $1
         AND status = 'ACTIVE'
         AND revision = $2
       RETURNING player_id, status, approved_review_id, revision::text`,
      [input.playerId, input.expectedRevision],
    );
    const row = result.rows[0];
    return row === undefined ? null : asRecord(row);
  }

  public async restore(input: ChangePlayerAccessWrite): Promise<PlayerAccessRecord | null> {
    const result = await this.client.query<PlayerAccessRow>(
      `UPDATE player_access
       SET status = 'ACTIVE',
           revision = revision + 1,
           suspended_reason = NULL,
           suspended_by = NULL,
           updated_at = now()
       WHERE player_id = $1
         AND status = 'SUSPENDED'
         AND revision = $2
       RETURNING player_id, status, approved_review_id, revision::text`,
      [input.playerId, input.expectedRevision],
    );
    const row = result.rows[0];
    return row === undefined ? null : asRecord(row);
  }
}

export class PostgresPlayerAccessRepository implements PlayerAccessRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (tx: PlayerAccessTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresPlayerAccessTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (tx: PlayerAccessTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresPlayerAccessTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
