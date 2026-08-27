import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { BattleStatusSchema, BattleTypeSchema } from "../../modules/battle/contracts.js";
import {
  EncounterAdminCloseResultSchema,
  EncounterAdminStateSchema,
  type EncounterAdminCloseInput,
  type EncounterAdminCloseResult,
  type EncounterAdminState,
} from "../../modules/encounter/admin-contracts.js";
import type {
  EncounterAdminClosePersistenceResult,
  EncounterAdminRepository,
} from "../../modules/encounter/admin-ports.js";
import { EncounterStatusSchema } from "../../modules/encounter/contracts.js";
import type { EncounterId, PlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

interface EncounterAdminRow {
  readonly encounter_id: string;
  readonly player_id: string;
  readonly encounter_status: string;
  readonly encounter_revision: string;
  readonly closed_at: Date | null;
  readonly battle_id: string | null;
  readonly battle_status: string | null;
  readonly battle_type: string | null;
  readonly reward_claimed: boolean | null;
  readonly pending_capture_attempt_id: string | null;
}

interface ClaimRow {
  readonly operation_kind: string;
  readonly player_id: string;
  readonly encounter_id: string;
  readonly request_fingerprint: string;
  readonly result: unknown;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

const INSPECT_SQL = `
  SELECT encounter.id AS encounter_id,
         encounter.player_id,
         encounter.status AS encounter_status,
         encounter.revision::text AS encounter_revision,
         encounter.closed_at,
         battle.id AS battle_id,
         battle.status AS battle_status,
         battle.battle_type,
         CASE
           WHEN battle.id IS NULL THEN NULL
           ELSE EXISTS (SELECT 1 FROM battle_reward_claims reward WHERE reward.battle_id = battle.id)
         END AS reward_claimed,
         pending_capture.id AS pending_capture_attempt_id
  FROM encounters encounter
  LEFT JOIN battles battle ON battle.encounter_id = encounter.id
  LEFT JOIN LATERAL (
    SELECT attempt.id
    FROM capture_attempts attempt
    WHERE attempt.encounter_id = encounter.id AND attempt.status = 'PENDING'
    ORDER BY attempt.created_at DESC, attempt.id
    LIMIT 1
  ) pending_capture ON TRUE
  WHERE encounter.player_id = $1 AND encounter.id = $2
`;

function mapState(row: EncounterAdminRow): EncounterAdminState {
  return EncounterAdminStateSchema.parse({
    encounterId: row.encounter_id,
    playerId: row.player_id,
    status: EncounterStatusSchema.parse(row.encounter_status),
    revision: row.encounter_revision,
    closedAt: row.closed_at?.toISOString() ?? null,
    battle:
      row.battle_id === null
        ? null
        : {
            battleId: row.battle_id,
            status: BattleStatusSchema.parse(row.battle_status),
            battleType: BattleTypeSchema.parse(row.battle_type),
            rewardClaimed: row.reward_claimed ?? false,
          },
    pendingCaptureAttemptId: row.pending_capture_attempt_id,
  });
}

function unsafeReason(state: EncounterAdminState): string | null {
  if (state.status === "CLOSED") return "Encounter is already CLOSED";
  if (state.status === "CAPTURE_RESOLVING" || state.pendingCaptureAttemptId !== null) {
    return "Encounter cannot be administratively closed while capture resolution is in flight";
  }
  if (state.status === "IN_BATTLE" && state.battle === null) {
    return "Encounter IN_BATTLE has no linked Battle; repair the inconsistent flow before closing";
  }
  if (
    state.battle !== null &&
    (["CREATED", "ACTIVE", "RESOLVING_TURN"] as const).includes(state.battle.status as never)
  ) {
    return "Encounter cannot be administratively closed while its linked Battle is active";
  }
  if (
    state.battle !== null &&
    state.battle.status === "WON" &&
    (state.battle.battleType === "WILD" || state.battle.battleType === "NPC") &&
    !state.battle.rewardClaimed
  ) {
    return "Encounter cannot be administratively closed before terminal PvE Battle reward settlement";
  }
  return null;
}

export class PostgresEncounterAdminRepository implements EncounterAdminRepository {
  public constructor(private readonly pool: Pool) {}

  public async inspect(playerId: PlayerId, encounterId: EncounterId): Promise<EncounterAdminState | null> {
    return withTransaction(
      this.pool,
      async (client) => {
        const result = await client.query<EncounterAdminRow>(INSPECT_SQL, [playerId, encounterId]);
        const row = result.rows[0];
        return row === undefined ? null : mapState(row);
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }

  public async close(input: EncounterAdminCloseInput): Promise<EncounterAdminClosePersistenceResult> {
    const requestFingerprint = fingerprint({
      playerId: input.playerId,
      encounterId: input.encounterId,
      expectedRevision: input.expectedRevision.toString(),
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `encounter:${input.encounterId}`,
        `encounter-admin-close:${input.idempotencyKey}`,
      ]);

      const replay = await client.query<ClaimRow>(
        `SELECT operation_kind, player_id, encounter_id, request_fingerprint, result
         FROM encounter_admin_operation_claims
         WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        if (
          replayRow.operation_kind !== "CLOSE" ||
          replayRow.player_id !== input.playerId ||
          replayRow.encounter_id !== input.encounterId ||
          replayRow.request_fingerprint !== requestFingerprint
        ) {
          return { kind: "IDEMPOTENCY_CONFLICT" };
        }
        return {
          kind: "REPLAYED",
          result: EncounterAdminCloseResultSchema.parse(replayRow.result),
        };
      }

      const inspected = await client.query<EncounterAdminRow>(`${INSPECT_SQL} FOR UPDATE OF encounter`, [
        input.playerId,
        input.encounterId,
      ]);
      const row = inspected.rows[0];
      if (row === undefined) return { kind: "NOT_FOUND" };
      const beforeState = mapState(row);
      const beforeRevision = BigInt(beforeState.revision);
      if (beforeRevision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      const unsafe = unsafeReason(beforeState);
      if (unsafe !== null) {
        return beforeState.status === "CLOSED"
          ? { kind: "INVALID_STATE", reason: unsafe }
          : { kind: "UNSAFE_FLOW", reason: unsafe };
      }

      const updated = await client.query<{
        revision: string;
        closed_at: Date;
      }>(
        `UPDATE encounters
         SET status = 'CLOSED',
             revision = revision + 1,
             updated_at = now(),
             closed_at = COALESCE(closed_at, now())
         WHERE id = $1 AND player_id = $2 AND revision = $3::bigint AND status = $4
         RETURNING revision::text, closed_at`,
        [
          input.encounterId,
          input.playerId,
          input.expectedRevision.toString(),
          beforeState.status,
        ],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) {
        const actual = await client.query<{ revision: string }>(
          `SELECT revision::text FROM encounters WHERE id = $1 AND player_id = $2`,
          [input.encounterId, input.playerId],
        );
        const actualRevision = actual.rows[0]?.revision;
        return actualRevision === undefined
          ? { kind: "NOT_FOUND" }
          : { kind: "REVISION_CONFLICT", actualRevision: BigInt(actualRevision) };
      }
      const afterState = EncounterAdminStateSchema.parse({
        ...beforeState,
        status: "CLOSED",
        revision: updatedRow.revision,
        closedAt: updatedRow.closed_at.toISOString(),
      });
      const result: EncounterAdminCloseResult = EncounterAdminCloseResultSchema.parse({
        encounterId: input.encounterId,
        operationKind: "CLOSE",
        beforeRevision: beforeState.revision,
        afterRevision: afterState.revision,
        beforeState,
        afterState,
        replayed: false,
      });

      await client.query(
        `INSERT INTO encounter_admin_operation_claims(
           id, operation_kind, player_id, encounter_id, idempotency_key,
           request_fingerprint, before_data, after_data, result, correlation_id
         ) VALUES ($1, 'CLOSE', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
        [
          randomUUID(),
          input.playerId,
          input.encounterId,
          input.idempotencyKey,
          requestFingerprint,
          JSON.stringify(beforeState),
          JSON.stringify(afterState),
          JSON.stringify(result),
          input.correlationId,
        ],
      );
      return { kind: "APPLIED", result };
    });
  }
}
