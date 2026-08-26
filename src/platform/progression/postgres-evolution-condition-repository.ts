import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ActivateEvolutionConditionInput,
  EvolutionConditionState,
  RevokeEvolutionConditionInput,
} from "../../modules/progression/evolution-condition-contracts.js";
import type {
  EvolutionConditionPersistenceResult,
  EvolutionConditionRepository,
} from "../../modules/progression/evolution-condition-ports.js";
import { withTransaction } from "../db/transaction.js";

interface ConditionRow {
  readonly status: "ACTIVE" | "REVOKED";
  readonly source_type: string;
  readonly source_id: string;
  readonly revision: string;
}

function safeRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Evolution condition revision is outside JS safe range");
  }
  return revision;
}

function state(
  input: {
    readonly pokemonInstanceId: string;
    readonly conditionKey: string;
    readonly status: "ACTIVE" | "REVOKED";
    readonly sourceType: string;
    readonly sourceId: string;
    readonly revision: number;
  },
  replayed: boolean,
): EvolutionConditionState {
  return { ...input, replayed };
}

async function lockCondition(
  client: PoolClient,
  pokemonInstanceId: string,
  conditionKey: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `progression:evolution-condition:${pokemonInstanceId}:${conditionKey}`,
  ]);
}

async function pokemonExists(client: PoolClient, pokemonInstanceId: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM pokemon_instances WHERE id = $1 AND status = 'ACTIVE'",
    [pokemonInstanceId],
  );
  return result.rows[0] !== undefined;
}

async function loadCondition(
  client: PoolClient,
  pokemonInstanceId: string,
  conditionKey: string,
): Promise<ConditionRow | null> {
  const result = await client.query<ConditionRow>(
    `SELECT status, source_type, source_id, revision::text
     FROM pokemon_evolution_condition_flags
     WHERE pokemon_instance_id = $1 AND condition_key = $2
     FOR UPDATE`,
    [pokemonInstanceId, conditionKey],
  );
  return result.rows[0] ?? null;
}

async function appendHistory(
  client: PoolClient,
  input: {
    readonly pokemonInstanceId: string;
    readonly eventType: string;
    readonly conditionKey: string;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly revision: number;
    readonly correlationId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO pokemon_history_events(
       id, pokemon_instance_id, event_type, payload, actor_type, actor_id, correlation_id
     ) VALUES ($1, $2, $3, $4::jsonb, 'SYSTEM', NULL, $5)`,
    [
      randomUUID(),
      input.pokemonInstanceId,
      input.eventType,
      JSON.stringify({
        conditionKey: input.conditionKey,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        revision: input.revision,
      }),
      input.correlationId,
    ],
  );
}

export class PostgresEvolutionConditionRepository implements EvolutionConditionRepository {
  public constructor(private readonly pool: Pool) {}

  public async activate(
    input: ActivateEvolutionConditionInput,
  ): Promise<EvolutionConditionPersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      await lockCondition(client, input.pokemonInstanceId, input.conditionKey);
      if (!(await pokemonExists(client, input.pokemonInstanceId))) {
        return { kind: "POKEMON_NOT_FOUND" };
      }
      const existing = await loadCondition(client, input.pokemonInstanceId, input.conditionKey);
      if (existing === null) {
        if (input.expectedRevision !== null) {
          return { kind: "STALE_REVISION", currentRevision: 0 };
        }
        await client.query(
          `INSERT INTO pokemon_evolution_condition_flags(
             pokemon_instance_id, condition_key, status, source_type, source_id,
             correlation_id, granted_at, revoked_at, revision
           ) VALUES ($1, $2, 'ACTIVE', $3, $4, $5, now(), NULL, 0)`,
          [
            input.pokemonInstanceId,
            input.conditionKey,
            input.sourceType,
            input.sourceId,
            input.correlationId,
          ],
        );
        await appendHistory(client, {
          ...input,
          eventType: "EVOLUTION_CONDITION_ACTIVATED",
          revision: 0,
        });
        return {
          kind: "APPLIED",
          state: state(
            {
              pokemonInstanceId: input.pokemonInstanceId,
              conditionKey: input.conditionKey,
              status: "ACTIVE",
              sourceType: input.sourceType,
              sourceId: input.sourceId,
              revision: 0,
            },
            false,
          ),
        };
      }

      const currentRevision = safeRevision(existing.revision);
      if (existing.source_type !== input.sourceType || existing.source_id !== input.sourceId) {
        return { kind: "SOURCE_CONFLICT" };
      }
      if (existing.status === "ACTIVE") {
        return {
          kind: "REPLAYED",
          state: state(
            {
              pokemonInstanceId: input.pokemonInstanceId,
              conditionKey: input.conditionKey,
              status: "ACTIVE",
              sourceType: existing.source_type,
              sourceId: existing.source_id,
              revision: currentRevision,
            },
            true,
          ),
        };
      }
      if (input.expectedRevision !== currentRevision) {
        return { kind: "STALE_REVISION", currentRevision };
      }
      const nextRevision = currentRevision + 1;
      const updated = await client.query(
        `UPDATE pokemon_evolution_condition_flags
         SET status = 'ACTIVE', correlation_id = $3, granted_at = now(), revoked_at = NULL,
             revision = revision + 1
         WHERE pokemon_instance_id = $1 AND condition_key = $2 AND revision = $4`,
        [input.pokemonInstanceId, input.conditionKey, input.correlationId, currentRevision],
      );
      if (updated.rowCount !== 1) return { kind: "STALE_REVISION", currentRevision };
      await appendHistory(client, {
        ...input,
        eventType: "EVOLUTION_CONDITION_ACTIVATED",
        revision: nextRevision,
      });
      return {
        kind: "APPLIED",
        state: state(
          {
            pokemonInstanceId: input.pokemonInstanceId,
            conditionKey: input.conditionKey,
            status: "ACTIVE",
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            revision: nextRevision,
          },
          false,
        ),
      };
    });
  }

  public async revoke(
    input: RevokeEvolutionConditionInput,
  ): Promise<EvolutionConditionPersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      await lockCondition(client, input.pokemonInstanceId, input.conditionKey);
      if (!(await pokemonExists(client, input.pokemonInstanceId))) {
        return { kind: "POKEMON_NOT_FOUND" };
      }
      const existing = await loadCondition(client, input.pokemonInstanceId, input.conditionKey);
      if (existing === null) return { kind: "CONDITION_NOT_FOUND" };
      const currentRevision = safeRevision(existing.revision);
      if (existing.source_type !== input.sourceType || existing.source_id !== input.sourceId) {
        return { kind: "SOURCE_CONFLICT" };
      }
      if (existing.status === "REVOKED") {
        return {
          kind: "REPLAYED",
          state: state(
            {
              pokemonInstanceId: input.pokemonInstanceId,
              conditionKey: input.conditionKey,
              status: "REVOKED",
              sourceType: existing.source_type,
              sourceId: existing.source_id,
              revision: currentRevision,
            },
            true,
          ),
        };
      }
      if (input.expectedRevision !== currentRevision) {
        return { kind: "STALE_REVISION", currentRevision };
      }
      const nextRevision = currentRevision + 1;
      const updated = await client.query(
        `UPDATE pokemon_evolution_condition_flags
         SET status = 'REVOKED', correlation_id = $3, revoked_at = now(), revision = revision + 1
         WHERE pokemon_instance_id = $1 AND condition_key = $2 AND revision = $4`,
        [input.pokemonInstanceId, input.conditionKey, input.correlationId, currentRevision],
      );
      if (updated.rowCount !== 1) return { kind: "STALE_REVISION", currentRevision };
      await appendHistory(client, {
        ...input,
        eventType: "EVOLUTION_CONDITION_REVOKED",
        revision: nextRevision,
      });
      return {
        kind: "APPLIED",
        state: state(
          {
            pokemonInstanceId: input.pokemonInstanceId,
            conditionKey: input.conditionKey,
            status: "REVOKED",
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            revision: nextRevision,
          },
          false,
        ),
      };
    });
  }
}
