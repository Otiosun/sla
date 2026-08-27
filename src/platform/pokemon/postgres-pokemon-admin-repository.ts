import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RulesetConfigSchema } from "../../modules/catalog/contracts.js";
import {
  type ArchivePokemonInput,
  type CorrectPokemonHpInput,
  type CorrectPokemonStatusInput,
  type MovePokemonRosterInput,
  PokemonOwnerMutationResultSchema,
  type PokemonOwnerMutationResult,
  type PokemonRosterPlacement,
} from "../../modules/pokemon/admin-contracts.js";
import type {
  PokemonAdminPersistenceResult,
  PokemonAdminRepository,
} from "../../modules/pokemon/admin-ports.js";
import { calculatePokemonStats } from "../../modules/pokemon/stats.js";
import { withTransaction } from "../db/transaction.js";

const MAJOR_STATUS_KEYS = ["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"] as const;

type OperationKind = "ROSTER_MOVE" | "HP_CORRECT" | "STATUS_CORRECT" | "ARCHIVE";

interface PokemonRow {
  readonly revision: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly current_hp: number;
}

interface ExistingClaimRow {
  readonly operation_kind: string;
  readonly player_id: string;
  readonly pokemon_instance_id: string;
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

async function loadClaim(
  client: PoolClient,
  input: {
    readonly idempotencyKey: string;
    readonly operationKind: OperationKind;
    readonly playerId: string;
    readonly pokemonInstanceId: string;
    readonly requestFingerprint: string;
  },
): Promise<PokemonAdminPersistenceResult | null> {
  const query = await client.query<ExistingClaimRow>(
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
    row.request_fingerprint !== input.requestFingerprint
  ) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  return {
    kind: "REPLAYED",
    result: PokemonOwnerMutationResultSchema.parse(row.result),
  };
}

async function insertClaim(
  client: PoolClient,
  input: {
    readonly operationKind: OperationKind;
    readonly playerId: string;
    readonly pokemonInstanceId: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly beforeData: Readonly<Record<string, unknown>>;
    readonly afterData: Readonly<Record<string, unknown>>;
    readonly result: PokemonOwnerMutationResult;
    readonly correlationId: string;
  },
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO pokemon_admin_operation_claims(
       id, operation_kind, player_id, pokemon_instance_id, idempotency_key,
       request_fingerprint, before_data, after_data, result, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      input.operationKind,
      input.playerId,
      input.pokemonInstanceId,
      input.idempotencyKey,
      input.requestFingerprint,
      JSON.stringify(input.beforeData),
      JSON.stringify(input.afterData),
      JSON.stringify(input.result),
      input.correlationId,
    ],
  );
  return inserted.rowCount === 1;
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

async function loadPokemon(
  client: PoolClient,
  playerId: string,
  pokemonInstanceId: string,
): Promise<PokemonRow | null> {
  const query = await client.query<PokemonRow>(
    `SELECT revision::text, status, current_hp
     FROM pokemon_instances
     WHERE id = $1 AND owner_player_id = $2
     FOR UPDATE`,
    [pokemonInstanceId, playerId],
  );
  return query.rows[0] ?? null;
}

async function hasUnsafeBattleReference(client: PoolClient, pokemonInstanceId: string): Promise<boolean> {
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

function rosterData(row: {
  readonly placement_kind: "TEAM" | "BOX";
  readonly box_no: number | null;
  readonly slot_no: number;
} | null): PokemonRosterPlacement | null {
  if (row === null) return null;
  return row.placement_kind === "TEAM"
    ? { placementKind: "TEAM", boxNo: null, slotNo: row.slot_no }
    : { placementKind: "BOX", boxNo: row.box_no ?? 1, slotNo: row.slot_no };
}

async function loadRoster(
  client: PoolClient,
  pokemonInstanceId: string,
): Promise<PokemonRosterPlacement | null> {
  const result = await client.query<{
    placement_kind: "TEAM" | "BOX";
    box_no: number | null;
    slot_no: number;
  }>(
    `SELECT placement_kind, box_no, slot_no
     FROM pokemon_roster_slots
     WHERE pokemon_instance_id = $1
     FOR UPDATE`,
    [pokemonInstanceId],
  );
  return rosterData(result.rows[0] ?? null);
}

function samePlacement(left: PokemonRosterPlacement | null, right: PokemonRosterPlacement): boolean {
  return (
    left !== null &&
    left.placementKind === right.placementKind &&
    left.boxNo === right.boxNo &&
    left.slotNo === right.slotNo
  );
}

async function targetRosterOccupied(
  client: PoolClient,
  playerId: string,
  pokemonInstanceId: string,
  target: PokemonRosterPlacement,
): Promise<boolean> {
  const result =
    target.placementKind === "TEAM"
      ? await client.query(
          `SELECT 1 FROM pokemon_roster_slots
           WHERE player_id = $1 AND placement_kind = 'TEAM' AND slot_no = $2
             AND pokemon_instance_id <> $3
           LIMIT 1 FOR UPDATE`,
          [playerId, target.slotNo, pokemonInstanceId],
        )
      : await client.query(
          `SELECT 1 FROM pokemon_roster_slots
           WHERE player_id = $1 AND placement_kind = 'BOX' AND box_no = $2 AND slot_no = $3
             AND pokemon_instance_id <> $4
           LIMIT 1 FOR UPDATE`,
          [playerId, target.boxNo, target.slotNo, pokemonInstanceId],
        );
  return result.rowCount === 1;
}

async function calculateActiveMaxHp(
  client: PoolClient,
  playerId: string,
  pokemonInstanceId: string,
): Promise<{ readonly maxHp: number } | null> {
  const query = await client.query<{
    ruleset_config: unknown;
    level: number;
    base_hp: number;
    base_attack: number;
    base_defense: number;
    base_sp_attack: number;
    base_sp_defense: number;
    base_speed: number;
    nature_id: string | null;
    increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
    decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
    iv_hp: number | null;
    iv_attack: number | null;
    iv_defense: number | null;
    iv_sp_attack: number | null;
    iv_sp_defense: number | null;
    iv_speed: number | null;
  }>(
    `SELECT ruleset.config AS ruleset_config, instance.level,
            form.base_hp, form.base_attack, form.base_defense,
            form.base_sp_attack, form.base_sp_defense, form.base_speed,
            training.nature_id, nature.increased_stat, nature.decreased_stat,
            training.iv_hp, training.iv_attack, training.iv_defense,
            training.iv_sp_attack, training.iv_sp_defense, training.iv_speed
     FROM pokemon_instances instance
     JOIN pokemon_training_values training ON training.pokemon_instance_id = instance.id
     JOIN content_release_pointers pointer ON pointer.pointer_key = 'ACTIVE'
     JOIN content_releases release
       ON release.id = pointer.content_release_id AND release.status = 'PUBLISHED'
     JOIN rulesets ruleset
       ON ruleset.id = release.default_ruleset_id AND ruleset.status = 'PUBLISHED'
     JOIN pokemon_form_revisions form
       ON form.content_release_id = release.id AND form.form_id = instance.form_id AND form.active = TRUE
     LEFT JOIN nature_revisions nature
       ON nature.content_release_id = release.id
      AND nature.nature_id = training.nature_id
      AND nature.active = TRUE
     WHERE instance.id = $1 AND instance.owner_player_id = $2`,
    [pokemonInstanceId, playerId],
  );
  const row = query.rows[0];
  if (row === undefined) return null;
  const parsedRules = RulesetConfigSchema.safeParse(row.ruleset_config);
  if (!parsedRules.success) return null;
  const battle = parsedRules.data.battle;
  if (battle.evEnabled) return null;
  if (battle.natureEnabled && (row.nature_id === null || row.increased_stat === undefined)) return null;
  const ivValues = [
    row.iv_hp,
    row.iv_attack,
    row.iv_defense,
    row.iv_sp_attack,
    row.iv_sp_defense,
    row.iv_speed,
  ];
  if (battle.ivEnabled && ivValues.some((value) => value === null)) return null;
  const stats = calculatePokemonStats({
    baseStats: {
      hp: row.base_hp,
      attack: row.base_attack,
      defense: row.base_defense,
      spAttack: row.base_sp_attack,
      spDefense: row.base_sp_defense,
      speed: row.base_speed,
    },
    ivs: {
      hp: row.iv_hp ?? 0,
      attack: row.iv_attack ?? 0,
      defense: row.iv_defense ?? 0,
      spAttack: row.iv_sp_attack ?? 0,
      spDefense: row.iv_sp_defense ?? 0,
      speed: row.iv_speed ?? 0,
    },
    level: row.level,
    nature: {
      increasedStat: row.increased_stat ?? null,
      decreasedStat: row.decreased_stat ?? null,
    },
    ivEnabled: battle.ivEnabled,
    natureEnabled: battle.natureEnabled,
  });
  return { maxHp: stats.hp };
}

function mutationResult(input: {
  readonly pokemonInstanceId: string;
  readonly operationKind: OperationKind;
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

export class PostgresPokemonAdminRepository implements PokemonAdminRepository {
  public constructor(private readonly pool: Pool) {}

  public async moveRoster(input: MovePokemonRosterInput): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      operationKind: "ROSTER_MOVE",
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      expectedRevision: input.expectedRevision.toString(),
      target: input.target,
    });
    return withTransaction(this.pool, async (client) => {
      const slotKey = `${input.target.placementKind}:${input.target.boxNo ?? "team"}:${input.target.slotNo}`;
      await acquireLocks(client, [
        `pokemon:${input.pokemonInstanceId}`,
        `pokemon-admin-key:${input.idempotencyKey}`,
        `pokemon-roster:${input.playerId}:${slotKey}`,
      ]);
      const replay = await loadClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "ROSTER_MOVE",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        requestFingerprint,
      });
      if (replay !== null) return replay;
      const pokemon = await loadPokemon(client, input.playerId, input.pokemonInstanceId);
      if (pokemon === null) return { kind: "NOT_FOUND" };
      const beforeRevision = BigInt(pokemon.revision);
      if (beforeRevision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      if (pokemon.status !== "ACTIVE") {
        return { kind: "INVALID_STATE", reason: "Archived Pokemon cannot move between roster slots" };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }
      const beforePlacement = await loadRoster(client, input.pokemonInstanceId);
      if (samePlacement(beforePlacement, input.target)) {
        return { kind: "INVALID_STATE", reason: "Pokemon is already in the requested roster slot" };
      }
      if (
        await targetRosterOccupied(client, input.playerId, input.pokemonInstanceId, input.target)
      ) {
        return { kind: "TARGET_OCCUPIED" };
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
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      await client.query(
        `INSERT INTO pokemon_roster_slots(
           pokemon_instance_id, player_id, placement_kind, box_no, slot_no
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (pokemon_instance_id) DO UPDATE
         SET placement_kind = EXCLUDED.placement_kind,
             box_no = EXCLUDED.box_no,
             slot_no = EXCLUDED.slot_no,
             updated_at = now()`,
        [
          input.pokemonInstanceId,
          input.playerId,
          input.target.placementKind,
          input.target.boxNo,
          input.target.slotNo,
        ],
      );
      const afterRevision = BigInt(afterRevisionRaw);
      const beforeData = { placement: beforePlacement, revision: beforeRevision.toString() };
      const afterData = { placement: input.target, revision: afterRevision.toString() };
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_ROSTER_MOVED",
        payload: { before: beforePlacement, after: input.target, reason: input.metadata.reason },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId: input.pokemonInstanceId,
        operationKind: "ROSTER_MOVE",
        beforeRevision,
        afterRevision,
        beforeData,
        afterData,
      });
      if (
        !(await insertClaim(client, {
          operationKind: "ROSTER_MOVE",
          playerId: input.playerId,
          pokemonInstanceId: input.pokemonInstanceId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          beforeData,
          afterData,
          result,
          correlationId: input.correlationId,
        }))
      ) {
        return { kind: "IDEMPOTENCY_CONFLICT" };
      }
      return { kind: "APPLIED", result };
    });
  }

  public async correctHp(input: CorrectPokemonHpInput): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      operationKind: "HP_CORRECT",
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      expectedRevision: input.expectedRevision.toString(),
      currentHp: input.currentHp,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon:${input.pokemonInstanceId}`,
        `pokemon-admin-key:${input.idempotencyKey}`,
      ]);
      const replay = await loadClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "HP_CORRECT",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        requestFingerprint,
      });
      if (replay !== null) return replay;
      const pokemon = await loadPokemon(client, input.playerId, input.pokemonInstanceId);
      if (pokemon === null) return { kind: "NOT_FOUND" };
      const beforeRevision = BigInt(pokemon.revision);
      if (beforeRevision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      if (pokemon.status !== "ACTIVE") {
        return { kind: "INVALID_STATE", reason: "Archived Pokemon HP cannot be corrected" };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }
      const derived = await calculateActiveMaxHp(client, input.playerId, input.pokemonInstanceId);
      if (derived === null) {
        return {
          kind: "INVALID_STATE",
          reason: "Active content cannot derive this Pokemon maximum HP safely",
        };
      }
      if (input.currentHp > derived.maxHp) {
        return {
          kind: "INVALID_STATE",
          reason: `Corrected HP cannot exceed derived maximum HP ${derived.maxHp}`,
        };
      }
      const updated = await client.query<{ revision: string }>(
        `UPDATE pokemon_instances
         SET current_hp = $4, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND owner_player_id = $2 AND status = 'ACTIVE' AND revision = $3
         RETURNING revision::text`,
        [input.pokemonInstanceId, input.playerId, input.expectedRevision.toString(), input.currentHp],
      );
      const afterRevisionRaw = updated.rows[0]?.revision;
      if (afterRevisionRaw === undefined) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      const afterRevision = BigInt(afterRevisionRaw);
      const beforeData = {
        currentHp: pokemon.current_hp,
        maxHp: derived.maxHp,
        revision: beforeRevision.toString(),
      };
      const afterData = {
        currentHp: input.currentHp,
        maxHp: derived.maxHp,
        revision: afterRevision.toString(),
      };
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_HP_CORRECTED",
        payload: { beforeHp: pokemon.current_hp, afterHp: input.currentHp, maxHp: derived.maxHp, reason: input.metadata.reason },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId: input.pokemonInstanceId,
        operationKind: "HP_CORRECT",
        beforeRevision,
        afterRevision,
        beforeData,
        afterData,
      });
      if (
        !(await insertClaim(client, {
          operationKind: "HP_CORRECT",
          playerId: input.playerId,
          pokemonInstanceId: input.pokemonInstanceId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          beforeData,
          afterData,
          result,
          correlationId: input.correlationId,
        }))
      ) {
        return { kind: "IDEMPOTENCY_CONFLICT" };
      }
      return { kind: "APPLIED", result };
    });
  }

  public async correctStatus(
    input: CorrectPokemonStatusInput,
  ): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      operationKind: "STATUS_CORRECT",
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      expectedRevision: input.expectedRevision.toString(),
      status: input.status,
      counter: input.counter,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon:${input.pokemonInstanceId}`,
        `pokemon-admin-key:${input.idempotencyKey}`,
      ]);
      const replay = await loadClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "STATUS_CORRECT",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        requestFingerprint,
      });
      if (replay !== null) return replay;
      const pokemon = await loadPokemon(client, input.playerId, input.pokemonInstanceId);
      if (pokemon === null) return { kind: "NOT_FOUND" };
      const beforeRevision = BigInt(pokemon.revision);
      if (beforeRevision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      if (pokemon.status !== "ACTIVE") {
        return { kind: "INVALID_STATE", reason: "Archived Pokemon status cannot be corrected" };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }
      const current = await client.query<{
        condition_key: string;
        source_type: string;
        source_id: string;
        data: unknown;
      }>(
        `SELECT condition_key, source_type, source_id, data
         FROM pokemon_persistent_conditions
         WHERE pokemon_instance_id = $1 AND condition_key = ANY($2::text[])
         ORDER BY condition_key
         FOR UPDATE`,
        [input.pokemonInstanceId, MAJOR_STATUS_KEYS],
      );
      await client.query(
        `DELETE FROM pokemon_persistent_conditions
         WHERE pokemon_instance_id = $1 AND condition_key = ANY($2::text[])`,
        [input.pokemonInstanceId, MAJOR_STATUS_KEYS],
      );
      if (input.status !== null) {
        await client.query(
          `INSERT INTO pokemon_persistent_conditions(
             pokemon_instance_id, condition_key, source_type, source_id, data
           ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            input.pokemonInstanceId,
            input.status,
            input.metadata.sourceType,
            input.metadata.sourceId,
            JSON.stringify({ counter: input.counter }),
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
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      const afterRevision = BigInt(afterRevisionRaw);
      const beforeData = {
        majorStatuses: current.rows.map((row) => ({
          key: row.condition_key,
          sourceType: row.source_type,
          sourceId: row.source_id,
          data: row.data,
        })),
        revision: beforeRevision.toString(),
      };
      const afterData = {
        majorStatus: input.status === null ? null : { key: input.status, counter: input.counter },
        revision: afterRevision.toString(),
      };
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_STATUS_CORRECTED",
        payload: { before: beforeData.majorStatuses, after: afterData.majorStatus, reason: input.metadata.reason },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId: input.pokemonInstanceId,
        operationKind: "STATUS_CORRECT",
        beforeRevision,
        afterRevision,
        beforeData,
        afterData,
      });
      if (
        !(await insertClaim(client, {
          operationKind: "STATUS_CORRECT",
          playerId: input.playerId,
          pokemonInstanceId: input.pokemonInstanceId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          beforeData,
          afterData,
          result,
          correlationId: input.correlationId,
        }))
      ) {
        return { kind: "IDEMPOTENCY_CONFLICT" };
      }
      return { kind: "APPLIED", result };
    });
  }

  public async archivePokemon(input: ArchivePokemonInput): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      operationKind: "ARCHIVE",
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      expectedRevision: input.expectedRevision.toString(),
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon:${input.pokemonInstanceId}`,
        `pokemon-admin-key:${input.idempotencyKey}`,
      ]);
      const replay = await loadClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "ARCHIVE",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        requestFingerprint,
      });
      if (replay !== null) return replay;
      const pokemon = await loadPokemon(client, input.playerId, input.pokemonInstanceId);
      if (pokemon === null) return { kind: "NOT_FOUND" };
      const beforeRevision = BigInt(pokemon.revision);
      if (beforeRevision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      if (pokemon.status !== "ACTIVE") {
        return { kind: "INVALID_STATE", reason: "Pokemon is already archived" };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }
      const beforePlacement = await loadRoster(client, input.pokemonInstanceId);
      const effects = await client.query<{ id: string }>(
        `SELECT id FROM active_effects
         WHERE pokemon_instance_id = $1
         ORDER BY id
         FOR UPDATE`,
        [input.pokemonInstanceId],
      );
      await client.query(`DELETE FROM pokemon_roster_slots WHERE pokemon_instance_id = $1`, [
        input.pokemonInstanceId,
      ]);
      await client.query(`DELETE FROM active_effects WHERE pokemon_instance_id = $1`, [
        input.pokemonInstanceId,
      ]);
      const updated = await client.query<{ revision: string }>(
        `UPDATE pokemon_instances
         SET status = 'ARCHIVED', archived_at = now(), revision = revision + 1, updated_at = now()
         WHERE id = $1 AND owner_player_id = $2 AND status = 'ACTIVE' AND revision = $3
         RETURNING revision::text`,
        [input.pokemonInstanceId, input.playerId, input.expectedRevision.toString()],
      );
      const afterRevisionRaw = updated.rows[0]?.revision;
      if (afterRevisionRaw === undefined) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      const afterRevision = BigInt(afterRevisionRaw);
      const removedActiveEffectIds = effects.rows.map((row) => row.id);
      const beforeData = {
        status: "ACTIVE",
        placement: beforePlacement,
        activeEffectIds: removedActiveEffectIds,
        revision: beforeRevision.toString(),
      };
      const afterData = {
        status: "ARCHIVED",
        placement: null,
        activeEffectIds: [],
        revision: afterRevision.toString(),
      };
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_ARCHIVED",
        payload: {
          previousPlacement: beforePlacement,
          removedActiveEffectIds,
          reason: input.metadata.reason,
        },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId: input.pokemonInstanceId,
        operationKind: "ARCHIVE",
        beforeRevision,
        afterRevision,
        beforeData,
        afterData,
      });
      if (
        !(await insertClaim(client, {
          operationKind: "ARCHIVE",
          playerId: input.playerId,
          pokemonInstanceId: input.pokemonInstanceId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          beforeData,
          afterData,
          result,
          correlationId: input.correlationId,
        }))
      ) {
        return { kind: "IDEMPOTENCY_CONFLICT" };
      }
      return { kind: "APPLIED", result };
    });
  }
}
