import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  BattleStateSchema,
  type BattleEvent,
  type BattleState,
} from "../../modules/battle/contracts.js";
import type {
  BattleCancellationPersistenceResult,
  BattleCancellationPort,
  CancelBattleInput,
} from "../../modules/battle/runtime.js";
import { withTransaction } from "../db/transaction.js";

interface RootRow {
  readonly status: string;
  readonly version: string;
}

function safeVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("battle.version is outside JS safe range");
  }
  return parsed;
}

function cancelledState(source: BattleState): BattleState {
  const state = structuredClone(source);
  state.status = "CANCELLED";
  state.version += 1;
  for (const side of state.sides) side.result = "CANCELLED";
  return BattleStateSchema.parse(state);
}

export class PostgresBattleCancellation implements BattleCancellationPort {
  public constructor(private readonly pool: Pool) {}

  public async cancel(input: CancelBattleInput): Promise<BattleCancellationPersistenceResult> {
    return withTransaction(
      this.pool,
      async (client) => {
        const rootResult = await client.query<RootRow>(
          `SELECT status, version::text
           FROM battles
           WHERE id = $1
           FOR UPDATE`,
          [input.battleId],
        );
        const root = rootResult.rows[0];
        if (root === undefined) return { kind: "NOT_FOUND" };
        const rootVersion = safeVersion(root.version);

        const snapshotResult = await client.query<{ state: unknown }>(
          `SELECT state
           FROM battle_state_snapshots
           WHERE battle_id = $1 AND version = $2`,
          [input.battleId, rootVersion],
        );
        const snapshot = snapshotResult.rows[0];
        if (snapshot === undefined) return { kind: "NOT_INITIALIZED" };
        const currentState = BattleStateSchema.parse(snapshot.state);
        if (currentState.version !== rootVersion) {
          throw new Error("Battle root version and current snapshot version diverged");
        }

        if (root.status === "CANCELLED") {
          if (currentState.status !== "CANCELLED") {
            throw new Error("Cancelled battle root points to a non-cancelled snapshot");
          }
          return { kind: "REPLAYED", state: currentState };
        }
        if (rootVersion !== input.expectedVersion) {
          return { kind: "VERSION_CONFLICT", currentState };
        }
        if (root.status !== "ACTIVE" || currentState.status !== "ACTIVE") {
          return { kind: "NOT_ACTIVE", currentState };
        }

        const nextState = cancelledState(currentState);
        const updated = await client.query(
          `UPDATE battles
           SET status = 'CANCELLED',
               version = $3,
               updated_at = now(),
               ended_at = now()
           WHERE id = $1 AND version = $2 AND status = 'ACTIVE'`,
          [input.battleId, input.expectedVersion, nextState.version],
        );
        if (updated.rowCount !== 1) {
          throw new Error("Battle cancellation CAS changed after row lock");
        }

        await client.query(
          `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
           VALUES ($1, $2, 1, $3::jsonb)`,
          [input.battleId, nextState.version, JSON.stringify(nextState)],
        );

        const events: BattleEvent[] = [
          {
            type: "BattleEnded",
            payload: { status: "CANCELLED", reason: input.reason },
          },
        ];
        const seq = await client.query<{ next_seq: string }>(
          `SELECT (COALESCE(MAX(seq), 0) + 1)::text AS next_seq
           FROM battle_events
           WHERE battle_id = $1`,
          [input.battleId],
        );
        let nextSeq = BigInt(seq.rows[0]?.next_seq ?? "1");
        const correlationId = randomUUID();
        for (const event of events) {
          await client.query(
            `INSERT INTO battle_events(
               id, battle_id, seq, battle_version, event_type, payload,
               causation_id, correlation_id
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, $7)`,
            [
              randomUUID(),
              input.battleId,
              nextSeq.toString(),
              nextState.version,
              event.type,
              JSON.stringify(event.payload),
              correlationId,
            ],
          );
          nextSeq += 1n;
        }

        await client.query(
          `UPDATE battle_sides
           SET result = 'CANCELLED'
           WHERE battle_id = $1`,
          [input.battleId],
        );

        return { kind: "PERSISTED", state: nextState, events };
      },
      { isolationLevel: "READ COMMITTED" },
    );
  }
}
