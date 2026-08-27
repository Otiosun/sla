import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  BattleAdminActionView,
  BattleAdminCorrectStateInput,
  BattleAdminEventView,
  BattleAdminInspection,
  BattleAdminMutationResult,
  BattleAdminStateView,
} from "../../modules/battle/admin-contracts.js";
import type {
  BattleAdminCorrectionPersistenceResult,
  BattleAdminReplayResult,
  BattleAdminRepository,
} from "../../modules/battle/admin-ports.js";
import { correctActiveBattleState } from "../../modules/battle/admin-policy.js";
import {
  BattleStateSchema,
  BattleStatusSchema,
  BattleTypeSchema,
  type BattleState,
} from "../../modules/battle/contracts.js";
import { withTransaction } from "../db/transaction.js";

interface BattleRootViewRow {
  readonly battle_id: string;
  readonly player_id: string;
  readonly battle_type: string;
  readonly status: string;
  readonly version: string;
  readonly turn_number: number;
  readonly ended_at: Date | null;
  readonly encounter_id: string | null;
  readonly encounter_status: string | null;
  readonly reward_claimed: boolean;
}

interface EventRow {
  readonly seq: string;
  readonly battle_version: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly causation_id: string | null;
  readonly correlation_id: string;
  readonly created_at: Date;
}

interface ActionRow {
  readonly id: string;
  readonly action_type: string;
  readonly status: string;
  readonly expected_battle_version: string;
  readonly resolved_battle_version: string | null;
  readonly correlation_id: string;
  readonly created_at: Date;
}

function safeVersion(value: string, field = "battle version"): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} is outside JS safe range`);
  }
  return parsed;
}

function terminalStatus(status: string): boolean {
  return ["WON", "LOST", "FLED", "DRAW", "CANCELLED"].includes(status);
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

async function rootView(
  client: PoolClient,
  playerId: string,
  battleId: string,
  lock = false,
): Promise<BattleRootViewRow | null> {
  const result = await client.query<BattleRootViewRow>(
    `SELECT battle.id AS battle_id,
            COALESCE(player_side.player_id, encounter.player_id) AS player_id,
            battle.battle_type,
            battle.status,
            battle.version::text,
            battle.turn_number,
            battle.ended_at,
            battle.encounter_id,
            encounter.status AS encounter_status,
            EXISTS (
              SELECT 1 FROM battle_reward_claims reward WHERE reward.battle_id = battle.id
            ) AS reward_claimed
     FROM battles battle
     LEFT JOIN encounters encounter ON encounter.id = battle.encounter_id
     LEFT JOIN battle_sides player_side
       ON player_side.battle_id = battle.id
      AND player_side.controller_kind = 'PLAYER'
      AND player_side.player_id = $1
     WHERE battle.id = $2
       AND COALESCE(player_side.player_id, encounter.player_id) = $1
     ${lock ? "FOR UPDATE OF battle" : ""}`,
    [playerId, battleId],
  );
  return result.rows[0] ?? null;
}

async function resolvePlayerId(client: PoolClient, battleId: string): Promise<string | null> {
  const result = await client.query<{ player_id: string }>(
    `SELECT player_id
     FROM (
       SELECT side.player_id, 0 AS priority
       FROM battle_sides side
       WHERE side.battle_id = $1
         AND side.controller_kind = 'PLAYER'
         AND side.player_id IS NOT NULL
       UNION ALL
       SELECT encounter.player_id, 1 AS priority
       FROM battles battle
       JOIN encounters encounter ON encounter.id = battle.encounter_id
       WHERE battle.id = $1
     ) candidates
     ORDER BY priority, player_id
     LIMIT 1`,
    [battleId],
  );
  return result.rows[0]?.player_id ?? null;
}

async function loadSnapshot(
  client: PoolClient,
  battleId: string,
  version: number,
): Promise<BattleState | null> {
  const result = await client.query<{ state: unknown }>(
    `SELECT state FROM battle_state_snapshots WHERE battle_id = $1 AND version = $2`,
    [battleId, version],
  );
  const row = result.rows[0];
  return row === undefined ? null : BattleStateSchema.parse(row.state);
}

function mapStateView(
  root: BattleRootViewRow,
  state: BattleState | null,
  historicalVersion?: number,
): BattleAdminStateView {
  const version = state?.version ?? historicalVersion ?? safeVersion(root.version);
  const status = state?.status ?? BattleStatusSchema.parse(root.status);
  const isCurrent = version === safeVersion(root.version);
  return {
    battleId: root.battle_id,
    playerId: root.player_id,
    battleType: BattleTypeSchema.parse(root.battle_type),
    status,
    version,
    turnNumber: state?.turnNumber ?? root.turn_number,
    endedAt: isCurrent && terminalStatus(status) ? (root.ended_at?.toISOString() ?? null) : null,
    encounterId: root.encounter_id,
    encounterStatus: root.encounter_status,
    rewardClaimed: root.reward_claimed,
    state,
  };
}

async function stateViewAtVersion(
  client: PoolClient,
  playerId: string,
  battleId: string,
  version: number,
): Promise<BattleAdminStateView | null> {
  const root = await rootView(client, playerId, battleId);
  if (root === null) return null;
  const state = await loadSnapshot(client, battleId, version);
  if (state === null) return null;
  return mapStateView(root, state, version);
}

function eventView(row: EventRow): BattleAdminEventView {
  return {
    seq: row.seq,
    battleVersion: safeVersion(row.battle_version, "battle event version"),
    eventType: row.event_type,
    payload: row.payload,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
  };
}

function actionView(row: ActionRow): BattleAdminActionView {
  return {
    actionId: row.id,
    actionType: row.action_type,
    status: row.status,
    expectedVersion: safeVersion(row.expected_battle_version, "battle action expected version"),
    resolvedVersion:
      row.resolved_battle_version === null
        ? null
        : safeVersion(row.resolved_battle_version, "battle action resolved version"),
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
  };
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function needsEncounterClose(view: BattleAdminStateView): boolean {
  return (
    view.encounterId !== null && view.encounterStatus === "IN_BATTLE" && terminalStatus(view.status)
  );
}

async function replayWithClient(
  client: PoolClient,
  battleId: string,
  causationId: string,
  operationKind: "FORCE_CANCEL" | "CORRECT_STATE",
  requestFingerprint: string,
): Promise<BattleAdminReplayResult> {
  const eventResult = await client.query<EventRow>(
    `SELECT seq::text, battle_version::text, event_type, payload,
            causation_id, correlation_id, created_at
     FROM battle_events
     WHERE battle_id = $1 AND causation_id = $2
     ORDER BY seq DESC
     LIMIT 1`,
    [battleId, causationId],
  );
  const event = eventResult.rows[0];
  if (event === undefined) return { kind: "NONE" };
  const payload = payloadRecord(event.payload);
  if (
    payload?.operationKind !== operationKind ||
    payload.requestFingerprint !== requestFingerprint
  ) {
    return { kind: "CONFLICT" };
  }
  const afterVersion = safeVersion(event.battle_version, "admin battle event version");
  if (afterVersion < 1) throw new Error("Admin Battle mutation event cannot point to version zero");
  const playerId = await resolvePlayerId(client, battleId);
  if (playerId === null) throw new Error("Admin Battle replay cannot resolve owning player");
  const beforeState = await stateViewAtVersion(client, playerId, battleId, afterVersion - 1);
  const afterState = await stateViewAtVersion(client, playerId, battleId, afterVersion);
  if (beforeState === null || afterState === null) {
    throw new Error("Admin Battle replay evidence points to a missing state snapshot");
  }
  return {
    kind: "REPLAYED",
    result: {
      operationKind,
      beforeVersion: beforeState.version,
      afterVersion: afterState.version,
      beforeState,
      afterState,
      replayed: true,
      encounterNeedsClose: needsEncounterClose(afterState),
    },
  };
}

export class PostgresBattleAdminRepository implements BattleAdminRepository {
  public constructor(private readonly pool: Pool) {}

  public async inspect(playerId: string, battleId: string): Promise<BattleAdminInspection | null> {
    return withTransaction(
      this.pool,
      async (client) => {
        const root = await rootView(client, playerId, battleId);
        if (root === null) return null;
        const version = safeVersion(root.version);
        const state = await loadSnapshot(client, battleId, version);
        const events = await client.query<EventRow>(
          `SELECT seq::text, battle_version::text, event_type, payload,
                  causation_id, correlation_id, created_at
           FROM battle_events
           WHERE battle_id = $1
           ORDER BY seq DESC
           LIMIT 25`,
          [battleId],
        );
        const actions = await client.query<ActionRow>(
          `SELECT id, action_type, status, expected_battle_version::text,
                  resolved_battle_version::text, correlation_id, created_at
           FROM battle_actions
           WHERE battle_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 25`,
          [battleId],
        );
        return {
          ...mapStateView(root, state, version),
          recentEvents: events.rows.map(eventView),
          recentActions: actions.rows.map(actionView),
        };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }

  public async replayMutation(
    battleId: string,
    causationId: string,
    operationKind: "FORCE_CANCEL" | "CORRECT_STATE",
    requestFingerprint: string,
  ): Promise<BattleAdminReplayResult> {
    return withTransaction(
      this.pool,
      (client) =>
        replayWithClient(client, battleId, causationId, operationKind, requestFingerprint),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }

  public async correctState(
    input: BattleAdminCorrectStateInput & { readonly requestFingerprint: string },
  ): Promise<BattleAdminCorrectionPersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `battle:${input.battleId}`,
        `battle-admin:${input.idempotencyKey}`,
      ]);
      const replay = await replayWithClient(
        client,
        input.battleId,
        input.idempotencyKey,
        "CORRECT_STATE",
        input.requestFingerprint,
      );
      if (replay.kind === "CONFLICT") return { kind: "IDEMPOTENCY_CONFLICT" };
      if (replay.kind === "REPLAYED") return { kind: "REPLAYED", result: replay.result };

      const root = await rootView(client, input.playerId, input.battleId, true);
      if (root === null) return { kind: "NOT_FOUND" };
      if (BattleTypeSchema.parse(root.battle_type) === "PVP") {
        return {
          kind: "INVALID_CORRECTION",
          reason: "Subject-scoped Battle correction is not allowed for PVP Battles",
        };
      }
      const rootVersion = safeVersion(root.version);
      const currentState = await loadSnapshot(client, input.battleId, rootVersion);
      const currentView = mapStateView(root, currentState, rootVersion);
      if (rootVersion !== input.expectedVersion) {
        return { kind: "VERSION_CONFLICT", current: currentView };
      }
      if (root.status !== "ACTIVE" || currentState?.status !== "ACTIVE") {
        return { kind: "NOT_ACTIVE", current: currentView };
      }
      const corrected = correctActiveBattleState(currentState, input.correction);
      if (!corrected.ok) return { kind: "INVALID_CORRECTION", reason: corrected.reason };
      const nextState = corrected.state;

      const updated = await client.query(
        `UPDATE battles
         SET version = $3,
             updated_at = now()
         WHERE id = $1 AND version = $2 AND status = 'ACTIVE'`,
        [input.battleId, input.expectedVersion, nextState.version],
      );
      if (updated.rowCount !== 1) {
        const fresh = await rootView(client, input.playerId, input.battleId);
        if (fresh === null) return { kind: "NOT_FOUND" };
        const freshVersion = safeVersion(fresh.version);
        const freshState = await loadSnapshot(client, input.battleId, freshVersion);
        return {
          kind: "VERSION_CONFLICT",
          current: mapStateView(fresh, freshState, freshVersion),
        };
      }

      await client.query(
        `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
         VALUES ($1, $2, 1, $3::jsonb)`,
        [input.battleId, nextState.version, JSON.stringify(nextState)],
      );
      const seq = await client.query<{ next_seq: string }>(
        `SELECT (COALESCE(MAX(seq), 0) + 1)::text AS next_seq
         FROM battle_events WHERE battle_id = $1`,
        [input.battleId],
      );
      const nextSeq = seq.rows[0]?.next_seq ?? "1";
      await client.query(
        `INSERT INTO battle_events(
           id, battle_id, seq, battle_version, event_type, payload,
           causation_id, correlation_id
         ) VALUES ($1, $2, $3, $4, 'BattleStateCorrected', $5::jsonb, $6, $7)`,
        [
          randomUUID(),
          input.battleId,
          nextSeq,
          nextState.version,
          JSON.stringify({
            operationKind: "CORRECT_STATE",
            requestFingerprint: input.requestFingerprint,
            reason: input.metadata.reason,
            changes: corrected.changes,
          }),
          input.idempotencyKey,
          input.correlationId,
        ],
      );

      const afterRoot = await rootView(client, input.playerId, input.battleId);
      if (afterRoot === null) throw new Error("Corrected Battle disappeared after persistence");
      const afterState = mapStateView(afterRoot, nextState, nextState.version);
      const result: BattleAdminMutationResult = {
        operationKind: "CORRECT_STATE",
        beforeVersion: currentView.version,
        afterVersion: afterState.version,
        beforeState: currentView,
        afterState,
        replayed: false,
        encounterNeedsClose: false,
      };
      return { kind: "PERSISTED", result };
    });
  }
}
