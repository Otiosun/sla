import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  SceneProofRecord,
  WorldServiceKind,
  WorldServiceSessionRecord,
  WorldServiceSessionState,
} from "../../modules/world-services/contracts.js";
import type {
  ClaimSceneProofWrite,
  CloseWorldServiceSessionWrite,
  CreateWorldServiceSessionWrite,
  InsertSceneProofWrite,
  SetWorldServicePromptWrite,
  WorldServiceSessionRepository,
  WorldServiceSessionTransaction,
} from "../../modules/world-services/ports.js";
import { parsePlayerId, type PlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

interface SceneProofRow {
  readonly id: string;
  readonly player_id: string;
  readonly area_id: string;
  readonly source_inbox_message_id: string;
  readonly line_count: number;
  readonly created_at: Date;
  readonly consumed_at: Date | null;
}

interface WorldServiceSessionRow {
  readonly id: string;
  readonly player_id: string;
  readonly area_id: string;
  readonly service_kind: WorldServiceKind;
  readonly state: WorldServiceSessionState;
  readonly scene_proof_id: string | null;
  readonly expected_reply_outbox_idempotency_key: string | null;
  readonly expected_reply_external_message_id: string | null;
  readonly revision: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly closed_at: Date | null;
}

function asPlayerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function sceneProofRecord(row: SceneProofRow): SceneProofRecord {
  return {
    proofId: row.id,
    playerId: asPlayerId(row.player_id),
    areaId: row.area_id,
    sourceInboxMessageId: row.source_inbox_message_id,
    lineCount: row.line_count,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

function sessionRecord(row: WorldServiceSessionRow): WorldServiceSessionRecord {
  return {
    sessionId: row.id,
    playerId: asPlayerId(row.player_id),
    areaId: row.area_id,
    serviceKind: row.service_kind,
    state: row.state,
    sceneProofId: row.scene_proof_id,
    expectedReplyOutboxIdempotencyKey: row.expected_reply_outbox_idempotency_key,
    expectedReplyExternalMessageId: row.expected_reply_external_message_id,
    revision: BigInt(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

const SCENE_PROOF_RETURNING = `
  id,
  player_id,
  area_id,
  source_inbox_message_id,
  line_count,
  created_at,
  consumed_at
`;

const SESSION_RETURNING = `
  id,
  player_id,
  area_id,
  service_kind,
  state,
  scene_proof_id,
  expected_reply_outbox_idempotency_key,
  expected_reply_external_message_id,
  revision::text,
  created_at,
  updated_at,
  closed_at
`;

class PostgresWorldServiceSessionTransaction implements WorldServiceSessionTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async insertSceneProof(input: InsertSceneProofWrite): Promise<SceneProofRecord> {
    const result = await this.client.query<SceneProofRow>(
      `INSERT INTO world_service_scene_proofs(
         id, player_id, area_id, source_inbox_message_id, line_count, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SCENE_PROOF_RETURNING}`,
      [
        randomUUID(),
        input.playerId,
        input.areaId,
        input.sourceInboxMessageId,
        input.lineCount,
        input.createdAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("World service scene proof insert returned no row");
    return sceneProofRecord(row);
  }

  public async claimSceneProof(input: ClaimSceneProofWrite): Promise<SceneProofRecord | null> {
    const result = await this.client.query<SceneProofRow>(
      `WITH candidate AS (
         SELECT id
         FROM world_service_scene_proofs
         WHERE player_id = $1
           AND area_id = $2
           AND consumed_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE
       )
       UPDATE world_service_scene_proofs proof
       SET consumed_at = $3
       FROM candidate
       WHERE proof.id = candidate.id
       RETURNING ${SCENE_PROOF_RETURNING}`,
      [input.playerId, input.areaId, input.consumedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : sceneProofRecord(row);
  }

  public async activeSession(
    playerId: PlayerId,
    lock = false,
  ): Promise<WorldServiceSessionRecord | null> {
    const result = await this.client.query<WorldServiceSessionRow>(
      `SELECT ${SESSION_RETURNING}
       FROM world_service_sessions
       WHERE player_id = $1
         AND closed_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [playerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : sessionRecord(row);
  }

  public async createSession(
    input: CreateWorldServiceSessionWrite,
  ): Promise<WorldServiceSessionRecord> {
    const result = await this.client.query<WorldServiceSessionRow>(
      `INSERT INTO world_service_sessions(
         id, player_id, area_id, service_kind, state, scene_proof_id,
         revision, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'OPEN', $5, 0, $6, $6)
       RETURNING ${SESSION_RETURNING}`,
      [
        randomUUID(),
        input.playerId,
        input.areaId,
        input.serviceKind,
        input.sceneProofId,
        input.createdAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("World service session insert returned no row");
    return sessionRecord(row);
  }

  public async closeSession(
    input: CloseWorldServiceSessionWrite,
  ): Promise<WorldServiceSessionRecord | null> {
    const result = await this.client.query<WorldServiceSessionRow>(
      `UPDATE world_service_sessions
       SET state = 'CLOSED',
           expected_reply_outbox_idempotency_key = NULL,
           expected_reply_external_message_id = NULL,
           revision = revision + 1,
           updated_at = $3,
           closed_at = $3
       WHERE player_id = $1
         AND closed_at IS NULL
         AND revision = $2
       RETURNING ${SESSION_RETURNING}`,
      [input.playerId, input.expectedRevision, input.closedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : sessionRecord(row);
  }

  public async setActivePrompt(
    input: SetWorldServicePromptWrite,
  ): Promise<WorldServiceSessionRecord | null> {
    const result = await this.client.query<WorldServiceSessionRow>(
      `UPDATE world_service_sessions
       SET expected_reply_outbox_idempotency_key = $3,
           expected_reply_external_message_id = $4,
           revision = revision + 1,
           updated_at = $5
       WHERE player_id = $1
         AND closed_at IS NULL
         AND revision = $2
       RETURNING ${SESSION_RETURNING}`,
      [
        input.playerId,
        input.expectedRevision,
        input.outboxIdempotencyKey,
        input.externalMessageId,
        input.updatedAt,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : sessionRecord(row);
  }
}

export class PostgresWorldServiceSessionRepository implements WorldServiceSessionRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    work: (transaction: WorldServiceSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresWorldServiceSessionTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (transaction: WorldServiceSessionTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresWorldServiceSessionTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
