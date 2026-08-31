import type { Pool, PoolClient } from "pg";
import { BattleActionSchema } from "../../modules/battle/contracts.js";
import {
  createTurnWindow,
  submitTurnAction,
  type BattleTurnSubmission,
  type BattleTurnWindow,
  type CreateTurnWindowInput,
  type SubmitTurnActionInput,
  type SubmitTurnActionOutput,
  type TurnSubmissionStatus,
  type TurnWindowAggregate,
  type TurnWindowResult,
  type TurnWindowStatus,
} from "../../modules/battle/turn-window.js";
import { withTransaction } from "../db/transaction.js";

interface TurnWindowRow {
  readonly id: string;
  readonly battle_id: string;
  readonly battle_version: string;
  readonly turn_number: number;
  readonly status: TurnWindowStatus;
  readonly opened_at: Date;
  readonly deadline_at: Date;
  readonly locked_at: Date | null;
  readonly committed_at: Date | null;
  readonly revision: string;
  readonly resolution_correlation_id: string | null;
  readonly resolved_battle_version: string | null;
}

interface RequiredPlayerRow {
  readonly player_id: string;
  readonly side_no: number;
}

interface SubmissionRow {
  readonly id: string;
  readonly player_id: string;
  readonly side_no: number;
  readonly expected_battle_version: string;
  readonly idempotency_key: string;
  readonly action_payload: unknown;
  readonly submission_revision: string;
  readonly status: TurnSubmissionStatus;
  readonly submitted_at: Date;
}

export interface OpenTurnWindowOutput {
  readonly aggregate: TurnWindowAggregate;
  readonly replayed: boolean;
}

function failure(message: string): TurnWindowResult<never> {
  return {
    ok: false,
    error: {
      code: "TURN_WINDOW_INVALID",
      message,
    },
  };
}

function safeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside JS safe range`);
  }
  return parsed;
}

function parseWindow(
  row: TurnWindowRow,
  requiredPlayers: readonly RequiredPlayerRow[],
): BattleTurnWindow {
  return {
    id: row.id,
    battleId: row.battle_id,
    battleVersion: safeInteger(row.battle_version, "turn window battle version"),
    turnNumber: row.turn_number,
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    deadlineAt: row.deadline_at.toISOString(),
    lockedAt: row.locked_at?.toISOString() ?? null,
    committedAt: row.committed_at?.toISOString() ?? null,
    revision: safeInteger(row.revision, "turn window revision"),
    resolutionCorrelationId: row.resolution_correlation_id,
    resolvedBattleVersion:
      row.resolved_battle_version === null
        ? null
        : safeInteger(row.resolved_battle_version, "resolved battle version"),
    requiredPlayers: requiredPlayers.map((entry) => ({
      playerId: entry.player_id,
      sideNo: entry.side_no,
    })),
  };
}

function parseSubmission(row: SubmissionRow): BattleTurnSubmission {
  return {
    id: row.id,
    playerId: row.player_id,
    sideNo: row.side_no,
    expectedBattleVersion: safeInteger(
      row.expected_battle_version,
      "turn submission expected battle version",
    ),
    idempotencyKey: row.idempotency_key,
    action: BattleActionSchema.parse(row.action_payload),
    submissionRevision: safeInteger(row.submission_revision, "turn submission revision"),
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
  };
}

async function loadAggregateById(
  client: PoolClient,
  turnWindowId: string,
  lock: boolean,
): Promise<TurnWindowAggregate | null> {
  const windowResult = await client.query<TurnWindowRow>(
    `SELECT id, battle_id, battle_version::text, turn_number, status,
            opened_at, deadline_at, locked_at, committed_at, revision::text,
            resolution_correlation_id, resolved_battle_version::text
     FROM battle_turn_windows
     WHERE id = $1
     ${lock ? "FOR UPDATE" : ""}`,
    [turnWindowId],
  );
  const row = windowResult.rows[0];
  if (row === undefined) return null;

  const requiredPlayers = await client.query<RequiredPlayerRow>(
    `SELECT player_id, side_no
     FROM battle_turn_window_required_players
     WHERE turn_window_id = $1
     ORDER BY side_no, player_id`,
    [turnWindowId],
  );
  const submissions = await client.query<SubmissionRow>(
    `SELECT id, player_id, side_no, expected_battle_version::text,
            idempotency_key, action_payload, submission_revision::text,
            status, submitted_at
     FROM battle_turn_submissions
     WHERE turn_window_id = $1
     ORDER BY player_id, submission_revision, id`,
    [turnWindowId],
  );

  return {
    window: parseWindow(row, requiredPlayers.rows),
    submissions: submissions.rows.map(parseSubmission),
  };
}

async function loadAggregateByBattleVersion(
  client: PoolClient,
  battleId: string,
  battleVersion: number,
): Promise<TurnWindowAggregate | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM battle_turn_windows
     WHERE battle_id = $1 AND battle_version = $2`,
    [battleId, battleVersion],
  );
  const row = result.rows[0];
  return row === undefined ? null : loadAggregateById(client, row.id, false);
}

export async function openTurnWindowInTransaction(
  client: PoolClient,
  input: CreateTurnWindowInput,
): Promise<TurnWindowResult<OpenTurnWindowOutput>> {
  const created = createTurnWindow(input);
  if (!created.ok) return created;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO battle_turn_windows(
       id, battle_id, battle_version, turn_number, status,
       opened_at, deadline_at, revision
     ) VALUES ($1, $2, $3, $4, 'COLLECTING', $5, $6, 0)
     ON CONFLICT (battle_id, battle_version) DO NOTHING
     RETURNING id`,
    [
      created.value.window.id,
      created.value.window.battleId,
      created.value.window.battleVersion,
      created.value.window.turnNumber,
      created.value.window.openedAt,
      created.value.window.deadlineAt,
    ],
  );

  if (inserted.rowCount === 1) {
    for (const required of created.value.window.requiredPlayers) {
      await client.query(
        `INSERT INTO battle_turn_window_required_players(turn_window_id, player_id, side_no)
         VALUES ($1, $2, $3)`,
        [created.value.window.id, required.playerId, required.sideNo],
      );
    }
    return {
      ok: true,
      value: {
        aggregate: created.value,
        replayed: false,
      },
    };
  }

  const existing = await loadAggregateByBattleVersion(client, input.battleId, input.battleVersion);
  if (existing === null) {
    return failure("Turn window uniqueness conflict could not be replayed");
  }
  return {
    ok: true,
    value: {
      aggregate: existing,
      replayed: true,
    },
  };
}

export class PostgresBattleTurnWindowRepository {
  public constructor(private readonly pool: Pool) {}

  public async open(input: CreateTurnWindowInput): Promise<TurnWindowResult<OpenTurnWindowOutput>> {
    return withTransaction(this.pool, async (client) => openTurnWindowInTransaction(client, input));
  }

  public async loadByBattleVersion(
    battleId: string,
    battleVersion: number,
  ): Promise<TurnWindowResult<TurnWindowAggregate>> {
    return withTransaction(
      this.pool,
      async (client) => {
        const aggregate = await loadAggregateByBattleVersion(client, battleId, battleVersion);
        return aggregate === null
          ? failure("Turn window was not found")
          : { ok: true, value: aggregate };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }

  public async submit(
    turnWindowId: string,
    input: SubmitTurnActionInput,
  ): Promise<TurnWindowResult<SubmitTurnActionOutput>> {
    return withTransaction(this.pool, async (client) => {
      const current = await loadAggregateById(client, turnWindowId, true);
      if (current === null) return failure("Turn window was not found");

      const submitted = submitTurnAction(current, input);
      if (!submitted.ok || submitted.value.replayed) return submitted;

      const next = submitted.value.aggregate;
      for (const prior of current.submissions) {
        const changed = next.submissions.find((entry) => entry.id === prior.id);
        if (changed !== undefined && changed.status !== prior.status) {
          await client.query(
            `UPDATE battle_turn_submissions
             SET status = $2
             WHERE id = $1 AND turn_window_id = $3`,
            [prior.id, changed.status, turnWindowId],
          );
        }
      }

      const currentIds = new Set(current.submissions.map((entry) => entry.id));
      const insertedSubmission = next.submissions.find((entry) => !currentIds.has(entry.id));
      if (insertedSubmission === undefined) {
        throw new Error("Turn submission state changed without a new submission");
      }

      await client.query(
        `INSERT INTO battle_turn_submissions(
           id, turn_window_id, player_id, side_no, actor_participant_id,
           expected_battle_version, idempotency_key, action_type, action_payload,
           submission_revision, status, submitted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
        [
          insertedSubmission.id,
          turnWindowId,
          insertedSubmission.playerId,
          insertedSubmission.sideNo,
          insertedSubmission.action.actorParticipantId,
          insertedSubmission.expectedBattleVersion,
          insertedSubmission.idempotencyKey,
          insertedSubmission.action.type,
          JSON.stringify(insertedSubmission.action),
          insertedSubmission.submissionRevision,
          insertedSubmission.status,
          insertedSubmission.submittedAt,
        ],
      );

      await client.query(
        `UPDATE battle_turn_windows
         SET status = $2,
             locked_at = $3,
             revision = $4
         WHERE id = $1`,
        [turnWindowId, next.window.status, next.window.lockedAt, next.window.revision],
      );

      return submitted;
    });
  }
}
