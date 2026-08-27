import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ApplyPokemonEffectInput,
  PokemonOwnerMutationResult,
  RemovePokemonEffectInput,
} from "../../modules/pokemon/admin-contracts.js";
import { PokemonOwnerMutationResultSchema } from "../../modules/pokemon/admin-contracts.js";
import type { PokemonAdminPersistenceResult } from "../../modules/pokemon/admin-ports.js";
import type { PokemonEffectAdminRepository } from "../../modules/pokemon/effect-admin-ports.js";
import { withTransaction } from "../db/transaction.js";

type EffectOperationKind = "EFFECT_APPLY" | "EFFECT_REMOVE";

interface ClaimRow {
  readonly operation_kind: string;
  readonly player_id: string;
  readonly pokemon_instance_id: string;
  readonly request_fingerprint: string;
  readonly result: unknown;
}

function requestFingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

async function replayClaim(
  client: PoolClient,
  input: {
    readonly idempotencyKey: string;
    readonly operationKind: EffectOperationKind;
    readonly playerId: string;
    readonly pokemonInstanceId: string;
    readonly fingerprint: string;
  },
): Promise<PokemonAdminPersistenceResult | null> {
  const query = await client.query<ClaimRow>(
    `SELECT operation_kind, player_id, pokemon_instance_id, request_fingerprint, result
     FROM pokemon_admin_operation_claims
     WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  const row = query.rows[0];
  if (row === undefined) return null;
  if (
    row.operation_kind !== input.operationKind ||
    row.player_id !== input.playerId ||
    row.pokemon_instance_id !== input.pokemonInstanceId ||
    row.request_fingerprint !== input.fingerprint
  ) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  return { kind: "REPLAYED", result: PokemonOwnerMutationResultSchema.parse(row.result) };
}

async function loadPokemon(
  client: PoolClient,
  playerId: string,
  pokemonInstanceId: string,
): Promise<{ readonly revision: bigint; readonly status: string } | null> {
  const query = await client.query<{ revision: string; status: string }>(
    `SELECT revision::text, status
     FROM pokemon_instances
     WHERE id = $1 AND owner_player_id = $2
     FOR UPDATE`,
    [pokemonInstanceId, playerId],
  );
  const row = query.rows[0];
  return row === undefined ? null : { revision: BigInt(row.revision), status: row.status };
}

async function hasUnsafeBattleReference(
  client: PoolClient,
  pokemonInstanceId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM battle_participants participant
     JOIN battles battle ON battle.id = participant.battle_id
     WHERE participant.pokemon_instance_id = $1
       AND (
         battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
         OR (
           battle.status = 'WON'
           AND battle.battle_type IN ('WILD', 'NPC')
           AND NOT EXISTS (
             SELECT 1 FROM battle_reward_claims reward WHERE reward.battle_id = battle.id
           )
         )
       )
     LIMIT 1`,
    [pokemonInstanceId],
  );
  return result.rowCount === 1;
}

async function insertHistory(
  client: PoolClient,
  input: {
    readonly pokemonInstanceId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly actorType: "SYSTEM" | "ADMIN";
    readonly actorId: string | null;
    readonly correlationId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO pokemon_history_events(
       id, pokemon_instance_id, event_type, payload, actor_type, actor_id, correlation_id
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [
      randomUUID(),
      input.pokemonInstanceId,
      input.eventType,
      JSON.stringify(input.payload),
      input.actorType,
      input.actorId,
      input.correlationId,
    ],
  );
}

async function insertClaim(
  client: PoolClient,
  input: {
    readonly operationKind: EffectOperationKind;
    readonly playerId: string;
    readonly pokemonInstanceId: string;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly beforeData: Readonly<Record<string, unknown>>;
    readonly afterData: Readonly<Record<string, unknown>>;
    readonly result: PokemonOwnerMutationResult;
    readonly correlationId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO pokemon_admin_operation_claims(
       id, operation_kind, player_id, pokemon_instance_id, idempotency_key,
       request_fingerprint, before_data, after_data, result, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
    [
      randomUUID(),
      input.operationKind,
      input.playerId,
      input.pokemonInstanceId,
      input.idempotencyKey,
      input.fingerprint,
      JSON.stringify(input.beforeData),
      JSON.stringify(input.afterData),
      JSON.stringify(input.result),
      input.correlationId,
    ],
  );
}

function mutationResult(input: {
  readonly pokemonInstanceId: string;
  readonly operationKind: EffectOperationKind;
  readonly beforeRevision: bigint;
  readonly afterRevision: bigint;
  readonly beforeData: Readonly<Record<string, unknown>>;
  readonly afterData: Readonly<Record<string, unknown>>;
}): PokemonOwnerMutationResult {
  return PokemonOwnerMutationResultSchema.parse({
    pokemonInstanceId: input.pokemonInstanceId,
    operationKind: input.operationKind,
    beforeRevision: input.beforeRevision.toString(),
    afterRevision: input.afterRevision.toString(),
    beforeData: input.beforeData,
    afterData: input.afterData,
    replayed: false,
  });
}

export class PostgresPokemonEffectAdminRepository implements PokemonEffectAdminRepository {
  public constructor(private readonly pool: Pool) {}

  public async applyEffect(input: ApplyPokemonEffectInput): Promise<PokemonAdminPersistenceResult> {
    const fingerprint = requestFingerprint({
      operationKind: "EFFECT_APPLY",
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      effectId: input.effectId,
      expectedRevision: input.expectedRevision.toString(),
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon:${input.pokemonInstanceId}`,
        `pokemon-effect:${input.pokemonInstanceId}:${input.effectId}`,
        `pokemon-admin-key:${input.idempotencyKey}`,
      ]);
      const replay = await replayClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "EFFECT_APPLY",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        fingerprint,
      });
      if (replay !== null) return replay;

      const pokemon = await loadPokemon(client, input.playerId, input.pokemonInstanceId);
      if (pokemon === null) return { kind: "NOT_FOUND" };
      if (pokemon.revision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: pokemon.revision };
      }
      if (pokemon.status !== "ACTIVE") {
        return { kind: "INVALID_STATE", reason: "Archived Pokemon cannot receive effects" };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }

      const definition = await client.query<{
        content_release_id: string;
        scope: string;
        stacking_policy: string;
        duration_model: string;
        rules: unknown;
      }>(
        `SELECT revision.content_release_id, revision.scope, revision.stacking_policy,
                revision.duration_model, revision.rules
         FROM content_release_pointers pointer
         JOIN content_releases release
           ON release.id = pointer.content_release_id AND release.status = 'PUBLISHED'
         JOIN effect_revisions revision
           ON revision.content_release_id = release.id
          AND revision.effect_id = $1
          AND revision.active = TRUE
         WHERE pointer.pointer_key = 'ACTIVE'`,
        [input.effectId],
      );
      const effect = definition.rows[0];
      if (effect === undefined) {
        return { kind: "INVALID_STATE", reason: "Effect is not active in the current release" };
      }
      if (
        effect.scope !== "POKEMON" ||
        effect.stacking_policy !== "REFRESH" ||
        effect.duration_model !== "PERSISTENT"
      ) {
        return {
          kind: "INVALID_STATE",
          reason: "Only persistent REFRESH Pokemon effects can be applied administratively",
        };
      }
      if (effect.rules === null || typeof effect.rules !== "object" || Array.isArray(effect.rules)) {
        return { kind: "INVALID_STATE", reason: "Published effect rules are invalid" };
      }

      const existing = await client.query<{
        id: string;
        source_type: string;
        source_id: string;
        stacks: number;
        config: unknown;
        starts_at: Date;
        expires_at: Date | null;
        revision: string;
      }>(
        `SELECT id, source_type, source_id, stacks, config, starts_at, expires_at, revision::text
         FROM active_effects
         WHERE pokemon_instance_id = $1 AND effect_id = $2
         ORDER BY id
         FOR UPDATE`,
        [input.pokemonInstanceId, input.effectId],
      );
      if (existing.rows.length > 1) {
        return {
          kind: "INVALID_STATE",
          reason: "Persistent REFRESH effect has duplicate active rows",
        };
      }
      const beforeEffect = existing.rows[0] ?? null;
      let activeEffectId: string;
      if (beforeEffect === null) {
        activeEffectId = randomUUID();
        await client.query(
          `INSERT INTO active_effects(
             id, effect_id, content_release_id, pokemon_instance_id,
             source_type, source_id, stacks, config, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, NULL)`,
          [
            activeEffectId,
            input.effectId,
            effect.content_release_id,
            input.pokemonInstanceId,
            input.metadata.sourceType,
            input.metadata.sourceId,
            JSON.stringify(effect.rules),
          ],
        );
      } else {
        activeEffectId = beforeEffect.id;
        await client.query(
          `UPDATE active_effects
           SET content_release_id = $2, source_type = $3, source_id = $4,
               stacks = 1, config = $5::jsonb, starts_at = now(), expires_at = NULL,
               revision = revision + 1
           WHERE id = $1`,
          [
            activeEffectId,
            effect.content_release_id,
            input.metadata.sourceType,
            input.metadata.sourceId,
            JSON.stringify(effect.rules),
          ],
        );
      }

      const updated = await client.query<{ revision: string }>(
        `UPDATE pokemon_instances
         SET revision = revision + 1, updated_at = now()
         WHERE id = $1 AND owner_player_id = $2 AND status = 'ACTIVE' AND revision = $3
         RETURNING revision::text`,
        [input.pokemonInstanceId, input.playerId, input.expectedRevision.toString()],
      );
      const afterRevisionRaw = updated.rows[0]?.revision;
      if (afterRevisionRaw === undefined) {
        return { kind: "REVISION_CONFLICT", actualRevision: pokemon.revision };
      }
      const afterRevision = BigInt(afterRevisionRaw);
      const beforeData = {
        activeEffect: beforeEffect,
        revision: pokemon.revision.toString(),
      };
      const afterData = {
        activeEffect: {
          id: activeEffectId,
          effectId: input.effectId,
          contentReleaseId: effect.content_release_id,
          sourceType: input.metadata.sourceType,
          sourceId: input.metadata.sourceId,
          stacks: 1,
          config: effect.rules,
          expiresAt: null,
        },
        revision: afterRevision.toString(),
      };
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_EFFECT_APPLIED",
        payload: {
          activeEffectId,
          effectId: input.effectId,
          refreshed: beforeEffect !== null,
          reason: input.metadata.reason,
        },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId: input.pokemonInstanceId,
        operationKind: "EFFECT_APPLY",
        beforeRevision: pokemon.revision,
        afterRevision,
        beforeData,
        afterData,
      });
      await insertClaim(client, {
        operationKind: "EFFECT_APPLY",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        beforeData,
        afterData,
        result,
        correlationId: input.correlationId,
      });
      return { kind: "APPLIED", result };
    });
  }

  public async removeEffect(
    input: RemovePokemonEffectInput,
  ): Promise<PokemonAdminPersistenceResult> {
    const fingerprint = requestFingerprint({
      operationKind: "EFFECT_REMOVE",
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      activeEffectId: input.activeEffectId,
      expectedRevision: input.expectedRevision.toString(),
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon:${input.pokemonInstanceId}`,
        `pokemon-active-effect:${input.activeEffectId}`,
        `pokemon-admin-key:${input.idempotencyKey}`,
      ]);
      const replay = await replayClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "EFFECT_REMOVE",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        fingerprint,
      });
      if (replay !== null) return replay;

      const pokemon = await loadPokemon(client, input.playerId, input.pokemonInstanceId);
      if (pokemon === null) return { kind: "NOT_FOUND" };
      if (pokemon.revision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: pokemon.revision };
      }
      if (pokemon.status !== "ACTIVE") {
        return { kind: "INVALID_STATE", reason: "Archived Pokemon effects cannot be edited" };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }

      const effect = await client.query<{
        id: string;
        effect_id: string;
        content_release_id: string;
        source_type: string;
        source_id: string;
        stacks: number;
        config: unknown;
        starts_at: Date;
        expires_at: Date | null;
        revision: string;
      }>(
        `SELECT id, effect_id, content_release_id, source_type, source_id,
                stacks, config, starts_at, expires_at, revision::text
         FROM active_effects
         WHERE id = $1 AND pokemon_instance_id = $2
         FOR UPDATE`,
        [input.activeEffectId, input.pokemonInstanceId],
      );
      const row = effect.rows[0];
      if (row === undefined) return { kind: "NOT_FOUND" };

      await client.query(
        `DELETE FROM active_effects WHERE id = $1 AND pokemon_instance_id = $2`,
        [input.activeEffectId, input.pokemonInstanceId],
      );
      const updated = await client.query<{ revision: string }>(
        `UPDATE pokemon_instances
         SET revision = revision + 1, updated_at = now()
         WHERE id = $1 AND owner_player_id = $2 AND status = 'ACTIVE' AND revision = $3
         RETURNING revision::text`,
        [input.pokemonInstanceId, input.playerId, input.expectedRevision.toString()],
      );
      const afterRevisionRaw = updated.rows[0]?.revision;
      if (afterRevisionRaw === undefined) {
        return { kind: "REVISION_CONFLICT", actualRevision: pokemon.revision };
      }
      const afterRevision = BigInt(afterRevisionRaw);
      const beforeData = {
        activeEffect: row,
        revision: pokemon.revision.toString(),
      };
      const afterData = { activeEffect: null, revision: afterRevision.toString() };
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_EFFECT_REMOVED",
        payload: {
          activeEffectId: input.activeEffectId,
          effectId: row.effect_id,
          reason: input.metadata.reason,
        },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId: input.pokemonInstanceId,
        operationKind: "EFFECT_REMOVE",
        beforeRevision: pokemon.revision,
        afterRevision,
        beforeData,
        afterData,
      });
      await insertClaim(client, {
        operationKind: "EFFECT_REMOVE",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        beforeData,
        afterData,
        result,
        correlationId: input.correlationId,
      });
      return { kind: "APPLIED", result };
    });
  }
}
