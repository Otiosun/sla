import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  EntitlementGrantInput,
  EntitlementGrantModel,
  EntitlementGrantResult,
  PlayerEntitlementView,
} from "../../modules/entitlements/contracts.js";
import type { EntitlementRepository } from "../../modules/entitlements/ports.js";
import { withTransaction } from "../db/transaction.js";

interface EntitlementStateRow {
  player_id: string;
  entitlement_key: string;
  grant_model: EntitlementGrantModel;
  administrative_status: "ACTIVE" | "REVOKED";
  starts_at: Date;
  expires_at: Date | null;
  revision: string;
}

interface GrantReplayRow {
  player_id: string;
  entitlement_key: string;
  grant_model: EntitlementGrantModel;
  request_fingerprint: string;
  resulting_starts_at: Date;
  resulting_expires_at: Date | null;
  resulting_revision: string;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    );
  }
  return value;
}

function requestFingerprint(input: EntitlementGrantInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        normalize({
          playerId: input.playerId,
          entitlementKey: input.entitlementKey,
          grantModel: input.grantModel,
          durationSeconds: input.durationSeconds,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          actorType: input.actorType,
          actorId: input.actorId,
          metadata: input.metadata,
        }),
      ),
    )
    .digest("hex");
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

function viewFromRow(row: EntitlementStateRow, now: Date): PlayerEntitlementView {
  return {
    playerId: row.player_id,
    entitlementKey: row.entitlement_key,
    grantModel: row.grant_model,
    administrativeStatus: row.administrative_status,
    startsAt: row.starts_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revision: row.revision,
    currentlyActive:
      row.administrative_status === "ACTIVE" &&
      (row.grant_model === "PERMANENT" || (row.expires_at !== null && row.expires_at > now)),
  };
}

function replayView(row: GrantReplayRow, now: Date): PlayerEntitlementView {
  return {
    playerId: row.player_id,
    entitlementKey: row.entitlement_key,
    grantModel: row.grant_model,
    administrativeStatus: "ACTIVE",
    startsAt: row.resulting_starts_at.toISOString(),
    expiresAt: row.resulting_expires_at?.toISOString() ?? null,
    revision: row.resulting_revision,
    currentlyActive:
      row.grant_model === "PERMANENT" ||
      (row.resulting_expires_at !== null && row.resulting_expires_at > now),
  };
}

export class PostgresEntitlementRepository implements EntitlementRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async grant(input: EntitlementGrantInput): Promise<EntitlementGrantResult> {
    const fingerprint = requestFingerprint(input);
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `entitlement-grant:${input.idempotencyScope}:${input.idempotencyKey}`,
        `entitlement-state:${input.playerId}:${input.entitlementKey}`,
      ]);

      const replay = await client.query<GrantReplayRow>(
        `SELECT player_id, entitlement_key, grant_model, request_fingerprint,
                resulting_starts_at, resulting_expires_at, resulting_revision::text
         FROM entitlement_grants
         WHERE idempotency_scope = $1 AND idempotency_key = $2`,
        [input.idempotencyScope, input.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        if (replayRow.request_fingerprint !== fingerprint) {
          return { kind: "IDEMPOTENCY_CONFLICT" };
        }
        return {
          kind: "APPLIED",
          replayed: true,
          entitlement: replayView(replayRow, this.now()),
        };
      }

      const player = await client.query(`SELECT 1 FROM players WHERE id = $1`, [input.playerId]);
      if (player.rowCount !== 1) return { kind: "PLAYER_NOT_FOUND" };

      const definition = await client.query<{
        grant_model: EntitlementGrantModel;
        active: boolean;
      }>(
        `SELECT grant_model, active
         FROM entitlement_definitions
         WHERE key = $1`,
        [input.entitlementKey],
      );
      const definitionRow = definition.rows[0];
      if (definitionRow === undefined) return { kind: "DEFINITION_NOT_FOUND" };
      if (!definitionRow.active) return { kind: "DEFINITION_INACTIVE" };
      if (definitionRow.grant_model !== input.grantModel) {
        return { kind: "GRANT_MODEL_MISMATCH" };
      }

      const current = await client.query<EntitlementStateRow>(
        `SELECT player_id, entitlement_key, grant_model, administrative_status,
                starts_at, expires_at, revision::text
         FROM player_entitlements
         WHERE player_id = $1 AND entitlement_key = $2
         FOR UPDATE`,
        [input.playerId, input.entitlementKey],
      );
      const previous = current.rows[0] ?? null;
      if (previous !== null && previous.grant_model !== input.grantModel) {
        return { kind: "GRANT_MODEL_MISMATCH" };
      }

      const now = this.now();
      const previousRevision = previous === null ? null : BigInt(previous.revision);
      const resultingRevision = previousRevision === null ? 0n : previousRevision + 1n;
      let resultingStartsAt = now;
      let resultingExpiresAt: Date | null = null;

      if (input.grantModel === "PERMANENT") {
        if (previous?.administrative_status === "ACTIVE") {
          resultingStartsAt = previous.starts_at;
        }
      } else {
        const durationSeconds = input.durationSeconds;
        if (durationSeconds === null) throw new Error("Timed entitlement lost durationSeconds");
        const previousStillActive =
          previous !== null &&
          previous.administrative_status === "ACTIVE" &&
          previous.expires_at !== null &&
          previous.expires_at > now;
        if (previousStillActive) resultingStartsAt = previous.starts_at;
        const base =
          previousStillActive && previous.expires_at !== null ? previous.expires_at : now;
        resultingExpiresAt = new Date(base.getTime() + durationSeconds * 1000);
      }

      if (previous === null) {
        await client.query(
          `INSERT INTO player_entitlements(
             player_id, entitlement_key, grant_model, administrative_status,
             starts_at, expires_at, revision, updated_at
           ) VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, now())`,
          [
            input.playerId,
            input.entitlementKey,
            input.grantModel,
            resultingStartsAt,
            resultingExpiresAt,
            resultingRevision.toString(),
          ],
        );
      } else {
        const updated = await client.query(
          `UPDATE player_entitlements
           SET administrative_status = 'ACTIVE', starts_at = $3, expires_at = $4,
               revision = $5, updated_at = now()
           WHERE player_id = $1 AND entitlement_key = $2 AND revision = $6`,
          [
            input.playerId,
            input.entitlementKey,
            resultingStartsAt,
            resultingExpiresAt,
            resultingRevision.toString(),
            previousRevision?.toString(),
          ],
        );
        if (updated.rowCount !== 1) throw new Error("Entitlement revision changed under lock");
      }

      await client.query(
        `INSERT INTO entitlement_grants(
           id, player_id, entitlement_key, grant_model, duration_seconds,
           source_type, source_id, actor_type, actor_id,
           idempotency_scope, idempotency_key, request_fingerprint,
           previous_status, previous_starts_at, previous_expires_at, previous_revision,
           resulting_starts_at, resulting_expires_at, resulting_revision,
           metadata, correlation_id
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18, $19,
           $20::jsonb, $21
         )`,
        [
          randomUUID(),
          input.playerId,
          input.entitlementKey,
          input.grantModel,
          input.durationSeconds,
          input.sourceType,
          input.sourceId,
          input.actorType,
          input.actorId,
          input.idempotencyScope,
          input.idempotencyKey,
          fingerprint,
          previous?.administrative_status ?? null,
          previous?.starts_at ?? null,
          previous?.expires_at ?? null,
          previousRevision?.toString() ?? null,
          resultingStartsAt,
          resultingExpiresAt,
          resultingRevision.toString(),
          JSON.stringify(input.metadata),
          input.correlationId,
        ],
      );

      return {
        kind: "APPLIED",
        replayed: false,
        entitlement: {
          playerId: input.playerId,
          entitlementKey: input.entitlementKey,
          grantModel: input.grantModel,
          administrativeStatus: "ACTIVE",
          startsAt: resultingStartsAt.toISOString(),
          expiresAt: resultingExpiresAt?.toISOString() ?? null,
          revision: resultingRevision.toString(),
          currentlyActive: true,
        },
      };
    });
  }

  public async listPlayerEntitlements(playerId: string): Promise<readonly PlayerEntitlementView[]> {
    const now = this.now();
    const result = await this.pool.query<EntitlementStateRow>(
      `SELECT player_id, entitlement_key, grant_model, administrative_status,
              starts_at, expires_at, revision::text
       FROM player_entitlements
       WHERE player_id = $1
       ORDER BY entitlement_key`,
      [playerId],
    );
    return result.rows.map((row) => viewFromRow(row, now));
  }
}
