import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RegistrationSnapshot } from "../../modules/registration/contracts.js";
import type {
  InsertRegistrationRevisionWrite,
  RegistrationDraftRecord,
  RegistrationIdempotentOperation,
  RegistrationRepository,
  RegistrationRevisionRecord,
  RegistrationRevisionStatus,
  RegistrationTransaction,
  SaveRegistrationDraftWrite,
} from "../../modules/registration/ports.js";
import { validateRegistrationDraft } from "../../modules/registration/validation.js";
import { type PlayerId, parsePlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

interface DraftRow {
  readonly player_id: string;
  readonly snapshot_json: unknown;
  readonly revision: string;
}

interface RevisionRow {
  readonly id: string;
  readonly player_id: string;
  readonly sequence_no: string;
  readonly status: RegistrationRevisionStatus;
  readonly snapshot_json: unknown;
  readonly revision: string;
  readonly decided_by_admin_principal_id: string | null;
}

function asPlayerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function asSnapshot(value: unknown): RegistrationSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Database returned an invalid registration snapshot");
  }
  const validated = validateRegistrationDraft(value as RegistrationSnapshot);
  if (!validated.ok) throw new Error("Database returned an invalid registration snapshot");
  return validated.value;
}

function draftRecord(row: DraftRow): RegistrationDraftRecord {
  return {
    playerId: asPlayerId(row.player_id),
    snapshot: asSnapshot(row.snapshot_json),
    revision: Number(row.revision),
  };
}

function revisionRecord(row: RevisionRow): RegistrationRevisionRecord {
  return {
    id: row.id,
    playerId: asPlayerId(row.player_id),
    sequenceNo: Number(row.sequence_no),
    status: row.status,
    snapshot: asSnapshot(row.snapshot_json),
    revision: Number(row.revision),
    decidedByAdminPrincipalId: row.decided_by_admin_principal_id,
  };
}

class PostgresRegistrationTransaction implements RegistrationTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async loadDraft(playerId: PlayerId): Promise<RegistrationDraftRecord | null> {
    const result = await this.client.query<DraftRow>(
      `SELECT player_id, snapshot_json, revision::text
       FROM registration_drafts
       WHERE player_id = $1`,
      [playerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : draftRecord(row);
  }

  public async saveDraft(input: SaveRegistrationDraftWrite): Promise<RegistrationDraftRecord | null> {
    if (input.expectedRevision === null) {
      const inserted = await this.client.query<DraftRow>(
        `INSERT INTO registration_drafts(
           player_id, schema_version, snapshot_json, revision, created_at, updated_at
         ) VALUES ($1, $2, $3::jsonb, 0, now(), now())
         ON CONFLICT (player_id) DO NOTHING
         RETURNING player_id, snapshot_json, revision::text`,
        [input.playerId, input.snapshot.schemaVersion, JSON.stringify(input.snapshot)],
      );
      const row = inserted.rows[0];
      return row === undefined ? null : draftRecord(row);
    }

    const updated = await this.client.query<DraftRow>(
      `UPDATE registration_drafts
       SET schema_version = $2,
           snapshot_json = $3::jsonb,
           revision = revision + 1,
           updated_at = now()
       WHERE player_id = $1 AND revision = $4
       RETURNING player_id, snapshot_json, revision::text`,
      [
        input.playerId,
        input.snapshot.schemaVersion,
        JSON.stringify(input.snapshot),
        input.expectedRevision,
      ],
    );
    const row = updated.rows[0];
    return row === undefined ? null : draftRecord(row);
  }

  public async loadCurrentRevision(playerId: PlayerId): Promise<RegistrationRevisionRecord | null> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `registration-player:${playerId}`,
    ]);
    const result = await this.client.query<RevisionRow>(
      `SELECT id, player_id, sequence_no::text, status, snapshot_json, revision::text,
              decided_by_admin_principal_id
       FROM registration_revisions
       WHERE player_id = $1
       ORDER BY sequence_no DESC
       LIMIT 1`,
      [playerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : revisionRecord(row);
  }

  public async loadRevisionById(revisionId: string): Promise<RegistrationRevisionRecord | null> {
    const result = await this.client.query<RevisionRow>(
      `SELECT id, player_id, sequence_no::text, status, snapshot_json, revision::text,
              decided_by_admin_principal_id
       FROM registration_revisions
       WHERE id = $1`,
      [revisionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : revisionRecord(row);
  }

  public async loadIdempotencyReceipt(
    operation: RegistrationIdempotentOperation,
    idempotencyKey: string,
  ): Promise<RegistrationRevisionRecord | null> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `registration-idempotency:${operation}:${idempotencyKey}`,
    ]);
    const result = await this.client.query<RevisionRow>(
      `SELECT revision.id, revision.player_id, revision.sequence_no::text, revision.status,
              revision.snapshot_json, revision.revision::text,
              revision.decided_by_admin_principal_id
       FROM registration_idempotency_receipts receipt
       JOIN registration_revisions revision ON revision.id = receipt.revision_id
       WHERE receipt.operation = $1 AND receipt.idempotency_key = $2`,
      [operation, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : revisionRecord(row);
  }

  public async insertRevision(
    input: InsertRegistrationRevisionWrite,
  ): Promise<RegistrationRevisionRecord> {
    const result = await this.client.query<RevisionRow>(
      `INSERT INTO registration_revisions(
         id, player_id, sequence_no, status, schema_version, snapshot_json, revision,
         submitted_at, updated_at
       ) VALUES ($1, $2, $3, 'SUBMITTED', $4, $5::jsonb, 0, now(), now())
       RETURNING id, player_id, sequence_no::text, status, snapshot_json, revision::text,
                 decided_by_admin_principal_id`,
      [
        randomUUID(),
        input.playerId,
        input.sequenceNo,
        input.snapshot.schemaVersion,
        JSON.stringify(input.snapshot),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Registration revision insert returned no row");
    return revisionRecord(row);
  }

  public async saveIdempotencyReceipt(
    operation: RegistrationIdempotentOperation,
    idempotencyKey: string,
    revisionId: string,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO registration_idempotency_receipts(operation, idempotency_key, revision_id)
       VALUES ($1, $2, $3)`,
      [operation, idempotencyKey, revisionId],
    );
  }

  public async updateRevisionStatus(
    revisionId: string,
    expectedRevision: number,
    status: RegistrationRevisionStatus,
    decidedByAdminPrincipalId?: string,
  ): Promise<RegistrationRevisionRecord | null> {
    const terminal = status === "APPROVED" || status === "REJECTED";
    const result = await this.client.query<RevisionRow>(
      `UPDATE registration_revisions
       SET status = $3,
           revision = revision + 1,
           decided_by_admin_principal_id = CASE WHEN $4::boolean THEN $5::uuid ELSE NULL END,
           decided_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1 AND revision = $2
       RETURNING id, player_id, sequence_no::text, status, snapshot_json, revision::text,
                 decided_by_admin_principal_id`,
      [revisionId, expectedRevision, status, terminal, decidedByAdminPrincipalId ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? null : revisionRecord(row);
  }
}

export class PostgresRegistrationRepository implements RegistrationRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (tx: RegistrationTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresRegistrationTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (tx: RegistrationTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresRegistrationTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
