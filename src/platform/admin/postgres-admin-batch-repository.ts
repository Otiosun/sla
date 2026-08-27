import type { Pool, PoolClient } from "pg";
import {
  batchChildInput,
  type AdminBatchAction,
  type AdminBatchRecord,
  type AdminBatchSelector,
  type AdminBatchTargetResult,
} from "../../modules/admin/batch-contracts.js";
import type { AdminBatchRepository } from "../../modules/admin/batch-service.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import { withTransaction } from "../db/transaction.js";

interface BatchRow {
  readonly id: string;
  readonly principal_id: string;
  readonly preview_admin_operation_id: string;
  readonly execute_admin_operation_id: string | null;
  readonly child_operation_type: string;
  readonly child_capability_key: string;
  readonly status: "PREVIEWED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_ERRORS";
  readonly selector: unknown;
  readonly shared_input: unknown;
  readonly reason: string;
  readonly target_count: number;
  readonly checkpoint_ordinal: number;
  readonly success_count: number;
  readonly failure_count: number;
  readonly report: unknown;
  readonly correlation_id: string;
  readonly revision: string;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
}

interface TargetRow {
  readonly ordinal: number;
  readonly player_id: string;
  readonly child_input: unknown;
  readonly child_idempotency_key: string;
  readonly status: "PENDING" | "SUCCEEDED" | "FAILED";
  readonly child_admin_operation_id: string | null;
  readonly attempts: number;
  readonly result: unknown;
  readonly error_code: string | null;
}

const BATCH_SELECT = `
  SELECT id, principal_id, preview_admin_operation_id, execute_admin_operation_id,
         child_operation_type, child_capability_key, status, selector, shared_input,
         reason, target_count, checkpoint_ordinal, success_count, failure_count,
         report, correlation_id, revision::text, created_at, started_at, completed_at
  FROM admin_batches`;

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected persisted admin batch JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function toBatch(row: BatchRow): AdminBatchRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    previewAdminOperationId: row.preview_admin_operation_id,
    executeAdminOperationId: row.execute_admin_operation_id,
    childOperationType: row.child_operation_type,
    childCapabilityKey: row.child_capability_key,
    status: row.status,
    selector: jsonRecord(row.selector),
    sharedInput: jsonRecord(row.shared_input),
    reason: row.reason,
    targetCount: row.target_count,
    checkpointOrdinal: row.checkpoint_ordinal,
    successCount: row.success_count,
    failureCount: row.failure_count,
    report: jsonRecord(row.report),
    correlationId: row.correlation_id,
    revision: BigInt(row.revision),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function toTarget(row: TargetRow): AdminBatchTargetResult {
  return {
    ordinal: row.ordinal,
    playerId: row.player_id,
    childInput: jsonRecord(row.child_input),
    childIdempotencyKey: row.child_idempotency_key,
    status: row.status,
    childAdminOperationId: row.child_admin_operation_id,
    attempts: row.attempts,
    result: row.result === null ? null : jsonRecord(row.result),
    errorCode: row.error_code,
  };
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

async function loadBatch(
  client: PoolClient,
  batchId: string,
  lock = false,
): Promise<AdminBatchRecord | null> {
  const result = await client.query<BatchRow>(
    `${BATCH_SELECT} WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [batchId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toBatch(row);
}

async function resolvePlayers(
  client: PoolClient,
  selector: AdminBatchSelector,
): Promise<readonly string[]> {
  if (selector.kind === "PLAYER_IDS") {
    const result = await client.query<{ id: string }>(
      `SELECT requested.player_id::text AS id
       FROM unnest($1::uuid[]) WITH ORDINALITY AS requested(player_id, ordinal)
       JOIN players player ON player.id = requested.player_id
       ORDER BY requested.ordinal`,
      [selector.playerIds],
    );
    if (result.rows.length !== selector.playerIds.length) {
      throw new AdminError(
        ADMIN_ERROR_CODES.TARGET_NOT_FOUND,
        "One or more explicit batch player targets do not exist",
      );
    }
    return result.rows.map((row) => row.id);
  }

  const result = await client.query<{ id: string }>(
    `SELECT player.id::text AS id
     FROM players player
     LEFT JOIN player_profiles profile ON profile.player_id = player.id
     WHERE ($1::text IS NULL OR player.status = $1)
       AND ($2::uuid IS NULL OR profile.origin_region_id = $2)
     ORDER BY player.created_at, player.id
     LIMIT $3`,
    [selector.status ?? null, selector.originRegionId ?? null, selector.limit],
  );
  return result.rows.map((row) => row.id);
}

export class PostgresAdminBatchRepository implements AdminBatchRepository {
  public constructor(private readonly pool: Pool) {}

  public async createOrReplayPreview(input: {
    readonly batchId: string;
    readonly principalId: string;
    readonly previewAdminOperationId: string;
    readonly selector: AdminBatchSelector;
    readonly action: AdminBatchAction;
    readonly childOperationType: string;
    readonly childCapabilityKey: string;
    readonly chunkSize: number;
    readonly reason: string;
    readonly correlationId: string;
  }): Promise<{ readonly batch: AdminBatchRecord; readonly replayed: boolean }> {
    return withTransaction(
      this.pool,
      async (client) => {
        await advisoryLock(client, `admin-batch-preview:${input.previewAdminOperationId}`);
        const existing = await client.query<BatchRow>(
          `${BATCH_SELECT} WHERE preview_admin_operation_id = $1`,
          [input.previewAdminOperationId],
        );
        const existingRow = existing.rows[0];
        if (existingRow !== undefined) return { batch: toBatch(existingRow), replayed: true };

        const playerIds = await resolvePlayers(client, input.selector);
        if (playerIds.length === 0) {
          throw new AdminError(
            ADMIN_ERROR_CODES.TARGET_NOT_FOUND,
            "Admin batch selector resolved to zero players",
          );
        }
        const report = { sampleTargetIds: playerIds.slice(0, 10) };
        await client.query(
          `INSERT INTO admin_batches(
             id, principal_id, preview_admin_operation_id, child_operation_type,
             child_capability_key, status, selector, shared_input, reason, target_count,
             report, correlation_id
           ) VALUES (
             $1, $2, $3, $4, $5, 'PREVIEWED', $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11
           )`,
          [
            input.batchId,
            input.principalId,
            input.previewAdminOperationId,
            input.childOperationType,
            input.childCapabilityKey,
            JSON.stringify(input.selector),
            JSON.stringify({ action: input.action, chunkSize: input.chunkSize }),
            input.reason,
            playerIds.length,
            JSON.stringify(report),
            input.correlationId,
          ],
        );
        for (const [ordinal, playerId] of playerIds.entries()) {
          const childInput = batchChildInput(input.action, playerId);
          const childIdempotencyKey = `batch:${input.batchId}:${ordinal}`;
          await client.query(
            `INSERT INTO admin_batch_targets(
               batch_id, ordinal, player_id, child_input, child_idempotency_key
             ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [input.batchId, ordinal, playerId, JSON.stringify(childInput), childIdempotencyKey],
          );
          await client.query(
            `INSERT INTO admin_batch_target_results(batch_id, ordinal) VALUES ($1, $2)`,
            [input.batchId, ordinal],
          );
        }
        const created = await loadBatch(client, input.batchId);
        if (created === null) throw new Error("Admin batch disappeared after preview creation");
        return { batch: created, replayed: false };
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }

  public async getBatch(batchId: string): Promise<AdminBatchRecord | null> {
    return withTransaction(this.pool, (client) => loadBatch(client, batchId), {
      isolationLevel: "REPEATABLE READ",
      readOnly: true,
    });
  }

  public async claimExecution(input: {
    readonly batchId: string;
    readonly principalId: string;
    readonly executeAdminOperationId: string;
    readonly expectedRevision: bigint;
  }): Promise<{ readonly batch: AdminBatchRecord; readonly replayedTerminal: boolean }> {
    return withTransaction(
      this.pool,
      async (client) => {
        await advisoryLock(client, `admin-batch:${input.batchId}`);
        const current = await loadBatch(client, input.batchId, true);
        if (current === null) {
          throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin batch was not found");
        }
        if (current.principalId !== input.principalId) {
          throw new AdminError(
            ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
            "Admin batch belongs to a different principal",
          );
        }
        if (current.status === "COMPLETED" || current.status === "COMPLETED_WITH_ERRORS") {
          if (current.executeAdminOperationId !== input.executeAdminOperationId) {
            throw new AdminError(
              ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              "Terminal admin batch is owned by another execute operation",
            );
          }
          return { batch: current, replayedTerminal: true };
        }
        if (current.revision !== input.expectedRevision) {
          throw new AdminError(ADMIN_ERROR_CODES.REVISION_CONFLICT, "Admin batch revision changed", {
            expectedRevision: input.expectedRevision.toString(),
            actualRevision: current.revision.toString(),
          });
        }
        if (
          current.executeAdminOperationId !== null &&
          current.executeAdminOperationId !== input.executeAdminOperationId
        ) {
          throw new AdminError(
            ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "Admin batch execution is already claimed by another operation",
          );
        }
        if (current.status === "PREVIEWED") {
          const claimed = await client.query<BatchRow>(
            `${BATCH_SELECT.replace("FROM admin_batches", "FROM admin_batches")} WHERE id = $1`,
            [input.batchId],
          );
          await client.query(
            `UPDATE admin_batches
             SET execute_admin_operation_id = $2, status = 'RUNNING', started_at = now()
             WHERE id = $1 AND status = 'PREVIEWED' AND execute_admin_operation_id IS NULL`,
            [input.batchId, input.executeAdminOperationId],
          );
          void claimed;
        }
        const after = await loadBatch(client, input.batchId);
        if (after === null) throw new Error("Admin batch disappeared after execution claim");
        if (after.executeAdminOperationId !== input.executeAdminOperationId) {
          throw new AdminError(
            ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "Admin batch execution claim was lost",
          );
        }
        return { batch: after, replayedTerminal: false };
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }

  public async loadPendingTargets(
    batchId: string,
    limit: number,
  ): Promise<readonly AdminBatchTargetResult[]> {
    const result = await this.pool.query<TargetRow>(
      `SELECT target.ordinal, target.player_id, target.child_input, target.child_idempotency_key,
              outcome.status, outcome.child_admin_operation_id, outcome.attempts,
              outcome.result, outcome.error_code
       FROM admin_batch_targets target
       JOIN admin_batch_target_results outcome
         ON outcome.batch_id = target.batch_id AND outcome.ordinal = target.ordinal
       WHERE target.batch_id = $1 AND outcome.status = 'PENDING'
       ORDER BY target.ordinal
       LIMIT $2`,
      [batchId, limit],
    );
    return result.rows.map(toTarget);
  }

  public async recordAttempt(batchId: string, ordinal: number): Promise<void> {
    await this.pool.query(
      `UPDATE admin_batch_target_results
       SET attempts = attempts + 1, updated_at = now()
       WHERE batch_id = $1 AND ordinal = $2 AND status = 'PENDING'`,
      [batchId, ordinal],
    );
  }

  public async recordSuccess(input: {
    readonly batchId: string;
    readonly ordinal: number;
    readonly childAdminOperationId: string;
    readonly result: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE admin_batch_target_results
       SET status = 'SUCCEEDED', child_admin_operation_id = $3,
           result = $4::jsonb, error_code = NULL, updated_at = now()
       WHERE batch_id = $1 AND ordinal = $2 AND status = 'PENDING'`,
      [input.batchId, input.ordinal, input.childAdminOperationId, JSON.stringify(input.result)],
    );
  }

  public async recordFailure(input: {
    readonly batchId: string;
    readonly ordinal: number;
    readonly errorCode: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE admin_batch_target_results
       SET status = 'FAILED', result = NULL, error_code = $3, updated_at = now()
       WHERE batch_id = $1 AND ordinal = $2 AND status = 'PENDING'`,
      [input.batchId, input.ordinal, input.errorCode],
    );
  }

  public async refreshProgress(batchId: string): Promise<AdminBatchRecord> {
    return withTransaction(
      this.pool,
      async (client) => {
        await advisoryLock(client, `admin-batch:${batchId}`);
        const current = await loadBatch(client, batchId, true);
        if (current === null) {
          throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin batch was not found");
        }
        if (current.status === "COMPLETED" || current.status === "COMPLETED_WITH_ERRORS") {
          return current;
        }
        const aggregate = await client.query<{
          success_count: number;
          failure_count: number;
          pending_count: number;
          first_pending: number | null;
        }>(
          `SELECT
             count(*) FILTER (WHERE status = 'SUCCEEDED')::int AS success_count,
             count(*) FILTER (WHERE status = 'FAILED')::int AS failure_count,
             count(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
             min(ordinal) FILTER (WHERE status = 'PENDING')::int AS first_pending
           FROM admin_batch_target_results
           WHERE batch_id = $1`,
          [batchId],
        );
        const counts = aggregate.rows[0];
        if (counts === undefined) throw new Error("Admin batch result aggregate is missing");
        const checkpoint = counts.pending_count === 0 ? current.targetCount - 1 : (counts.first_pending ?? 0) - 1;
        const terminal = counts.pending_count === 0;
        const terminalStatus = counts.failure_count === 0 ? "COMPLETED" : "COMPLETED_WITH_ERRORS";
        await client.query(
          `UPDATE admin_batches
           SET checkpoint_ordinal = $2,
               success_count = $3,
               failure_count = $4,
               status = CASE WHEN $5::boolean THEN $6 ELSE status END,
               completed_at = CASE WHEN $5::boolean THEN now() ELSE completed_at END,
               revision = CASE WHEN $5::boolean THEN revision + 1 ELSE revision END,
               report = jsonb_build_object(
                 'successCount', $3::int,
                 'failureCount', $4::int,
                 'checkpointOrdinal', $2::int
               )
           WHERE id = $1 AND status = 'RUNNING'`,
          [
            batchId,
            checkpoint,
            counts.success_count,
            counts.failure_count,
            terminal,
            terminalStatus,
          ],
        );
        const refreshed = await loadBatch(client, batchId);
        if (refreshed === null) throw new Error("Admin batch disappeared after progress refresh");
        return refreshed;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }

  public async listFailures(batchId: string): Promise<readonly AdminBatchTargetResult[]> {
    const result = await this.pool.query<TargetRow>(
      `SELECT target.ordinal, target.player_id, target.child_input, target.child_idempotency_key,
              outcome.status, outcome.child_admin_operation_id, outcome.attempts,
              outcome.result, outcome.error_code
       FROM admin_batch_targets target
       JOIN admin_batch_target_results outcome
         ON outcome.batch_id = target.batch_id AND outcome.ordinal = target.ordinal
       WHERE target.batch_id = $1 AND outcome.status = 'FAILED'
       ORDER BY target.ordinal`,
      [batchId],
    );
    return result.rows.map(toTarget);
  }
}
