import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RulesetConfigSchema } from "../../modules/catalog/contracts.js";
import {
  type CorrectPokemonProgressInput,
  type CreatePokemonInput,
  PokemonCreateResultSchema,
  PokemonOwnerMutationResultSchema,
  type PokemonCreateResult,
  type PokemonOwnerMutationResult,
  type PokemonRosterPlacement,
} from "../../modules/pokemon/admin-contracts.js";
import type { PokemonAdminPersistenceResult } from "../../modules/pokemon/admin-ports.js";
import { generatePokemonBuild } from "../../modules/pokemon/generation.js";
import type {
  PokemonCreatePersistenceResult,
  PokemonLifecycleAdminRepository,
} from "../../modules/pokemon/lifecycle-admin-ports.js";
import {
  adjustCurrentHpAfterStatChange,
  calculatePokemonStats,
  type PokemonBaseStats,
} from "../../modules/pokemon/stats.js";
import { pokemonXpRequiredForNextLevel } from "../../modules/progression/rules.js";
import { withTransaction } from "../db/transaction.js";
import { recordPokedexOwnedByForm } from "../pokedex/postgres-pokedex-writer.js";
import { CounterRandomSource } from "../rng/counter-rng.js";

interface ActiveContent {
  readonly releaseId: string;
  readonly rulesetId: string;
  readonly rulesetConfig: ReturnType<typeof RulesetConfigSchema.parse>;
}

interface CreateClaimRow {
  readonly operation_kind: string;
  readonly player_id: string;
  readonly request_fingerprint: string;
  readonly result: unknown;
}

interface ProgressClaimRow {
  readonly operation_kind: string;
  readonly player_id: string;
  readonly pokemon_instance_id: string;
  readonly request_fingerprint: string;
  readonly result: unknown;
}

interface PokemonProgressRow {
  readonly revision: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly form_id: string;
  readonly level: number;
  readonly xp: string;
  readonly current_hp: number;
  readonly nature_id: string | null;
  readonly iv_hp: number | null;
  readonly iv_attack: number | null;
  readonly iv_defense: number | null;
  readonly iv_sp_attack: number | null;
  readonly iv_sp_defense: number | null;
  readonly iv_speed: number | null;
}

interface FormBuildRow {
  readonly base_hp: number;
  readonly base_attack: number;
  readonly base_defense: number;
  readonly base_sp_attack: number;
  readonly base_sp_defense: number;
  readonly base_speed: number;
}

interface NatureRow {
  readonly nature_id: string;
  readonly increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  readonly decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deterministicSeed(...parts: readonly string[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest();
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

async function loadActiveContent(client: PoolClient): Promise<ActiveContent | null> {
  const result = await client.query<{
    release_id: string;
    ruleset_id: string;
    config: unknown;
  }>(
    `SELECT release.id AS release_id, ruleset.id AS ruleset_id, ruleset.config
     FROM content_release_pointers pointer
     JOIN content_releases release
       ON release.id = pointer.content_release_id AND release.status = 'PUBLISHED'
     JOIN rulesets ruleset
       ON ruleset.id = release.default_ruleset_id AND ruleset.status = 'PUBLISHED'
     WHERE pointer.pointer_key = 'ACTIVE'`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const parsed = RulesetConfigSchema.safeParse(row.config);
  if (!parsed.success) return null;
  return { releaseId: row.release_id, rulesetId: row.ruleset_id, rulesetConfig: parsed.data };
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

async function nextRosterPlacement(
  client: PoolClient,
  playerId: string,
): Promise<PokemonRosterPlacement> {
  const team = await client.query<{ slot_no: number }>(
    `SELECT slot_no FROM pokemon_roster_slots
     WHERE player_id = $1 AND placement_kind = 'TEAM'
     ORDER BY slot_no`,
    [playerId],
  );
  const occupied = new Set(team.rows.map((row) => row.slot_no));
  for (let slotNo = 1; slotNo <= 6; slotNo += 1) {
    if (!occupied.has(slotNo)) return { placementKind: "TEAM", boxNo: null, slotNo };
  }
  const box = await client.query<{ next_slot: number }>(
    `SELECT COALESCE(MAX(slot_no), 0) + 1 AS next_slot
     FROM pokemon_roster_slots
     WHERE player_id = $1 AND placement_kind = 'BOX' AND box_no = 1`,
    [playerId],
  );
  return { placementKind: "BOX", boxNo: 1, slotNo: box.rows[0]?.next_slot ?? 1 };
}

function baseStats(row: FormBuildRow): PokemonBaseStats {
  return {
    hp: row.base_hp,
    attack: row.base_attack,
    defense: row.base_defense,
    spAttack: row.base_sp_attack,
    spDefense: row.base_sp_defense,
    speed: row.base_speed,
  };
}

async function loadFormBuild(
  client: PoolClient,
  releaseId: string,
  formId: string,
  level: number,
): Promise<{
  readonly form: FormBuildRow;
  readonly abilities: readonly string[];
  readonly natures: readonly NatureRow[];
  readonly moves: readonly {
    moveId: string;
    maxPp: number;
    learnMethod: "START" | "LEVEL";
    learnLevel: number | null;
  }[];
} | null> {
  const form = await client.query<FormBuildRow>(
    `SELECT base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     FROM pokemon_form_revisions
     WHERE content_release_id = $1 AND form_id = $2 AND active = TRUE`,
    [releaseId, formId],
  );
  const formRow = form.rows[0];
  if (formRow === undefined) return null;

  const [abilities, natures, moves] = await Promise.all([
    client.query<{ ability_id: string }>(
      `SELECT option.ability_id
       FROM pokemon_form_ability_options option
       JOIN ability_revisions ability
         ON ability.content_release_id = option.content_release_id
        AND ability.ability_id = option.ability_id AND ability.active = TRUE
       WHERE option.content_release_id = $1 AND option.form_id = $2 AND option.active = TRUE
       ORDER BY CASE option.slot_kind WHEN 'PRIMARY' THEN 1 WHEN 'SECONDARY' THEN 2 ELSE 3 END,
                option.ability_id`,
      [releaseId, formId],
    ),
    client.query<NatureRow>(
      `SELECT nature_id, increased_stat, decreased_stat
       FROM nature_revisions
       WHERE content_release_id = $1 AND active = TRUE
       ORDER BY nature_id`,
      [releaseId],
    ),
    client.query<{
      move_id: string;
      max_pp: number | null;
      learn_method: "START" | "LEVEL";
      learn_level: number | null;
    }>(
      `SELECT learnset.move_id, move.max_pp, learnset.learn_method, learnset.learn_level
       FROM move_learnset_entries learnset
       JOIN move_revisions move
         ON move.content_release_id = learnset.content_release_id
        AND move.move_id = learnset.move_id AND move.active = TRUE
       WHERE learnset.content_release_id = $1 AND learnset.form_id = $2
         AND learnset.active = TRUE AND learnset.learn_method IN ('START', 'LEVEL')
         AND (learnset.learn_method = 'START' OR learnset.learn_level <= $3)
       ORDER BY CASE learnset.learn_method WHEN 'START' THEN 0 ELSE 1 END,
                learnset.learn_level NULLS FIRST, learnset.move_id`,
      [releaseId, formId, level],
    ),
  ]);
  const moveRows = moves.rows.map((row) => {
    if (row.max_pp === null || row.max_pp <= 0) {
      throw new Error("Admin-created Pokemon has an eligible move without valid PP");
    }
    return {
      moveId: row.move_id,
      maxPp: row.max_pp,
      learnMethod: row.learn_method,
      learnLevel: row.learn_level,
    };
  });
  return {
    form: formRow,
    abilities: abilities.rows.map((row) => row.ability_id),
    natures: natures.rows,
    moves: moveRows,
  };
}

async function insertHistory(
  client: PoolClient,
  input: {
    readonly pokemonInstanceId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly actorType: string;
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
    readonly operationKind: "CREATE" | "PROGRESSION_CORRECT";
    readonly playerId: string;
    readonly pokemonInstanceId: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly beforeData: Readonly<Record<string, unknown>>;
    readonly afterData: Readonly<Record<string, unknown>>;
    readonly result: PokemonCreateResult | PokemonOwnerMutationResult;
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
      input.requestFingerprint,
      JSON.stringify(input.beforeData),
      JSON.stringify(input.afterData),
      JSON.stringify(input.result),
      input.correlationId,
    ],
  );
}

function progressResult(input: {
  readonly pokemonInstanceId: string;
  readonly beforeRevision: bigint;
  readonly afterRevision: bigint;
  readonly beforeData: Readonly<Record<string, unknown>>;
  readonly afterData: Readonly<Record<string, unknown>>;
}): PokemonOwnerMutationResult {
  return PokemonOwnerMutationResultSchema.parse({
    pokemonInstanceId: input.pokemonInstanceId,
    operationKind: "PROGRESSION_CORRECT",
    beforeRevision: input.beforeRevision.toString(),
    afterRevision: input.afterRevision.toString(),
    beforeData: input.beforeData,
    afterData: input.afterData,
    replayed: false,
  });
}

export class PostgresPokemonLifecycleAdminRepository implements PokemonLifecycleAdminRepository {
  public constructor(private readonly pool: Pool) {}

  public async createPokemon(input: CreatePokemonInput): Promise<PokemonCreatePersistenceResult> {
    const requestFingerprint = fingerprint({
      playerId: input.playerId,
      formId: input.formId,
      level: input.level,
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon-admin-create:${input.idempotencyKey}`,
        `pokemon-roster:${input.playerId}`,
      ]);
      const replay = await client.query<CreateClaimRow>(
        `SELECT operation_kind, player_id, request_fingerprint, result
         FROM pokemon_admin_operation_claims
         WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        if (
          replayRow.operation_kind !== "CREATE" ||
          replayRow.player_id !== input.playerId ||
          replayRow.request_fingerprint !== requestFingerprint
        ) {
          return { kind: "IDEMPOTENCY_CONFLICT" };
        }
        return {
          kind: "REPLAYED",
          result: PokemonCreateResultSchema.parse(replayRow.result),
        };
      }

      const player = await client.query<{ status: string }>(
        `SELECT status FROM players WHERE id = $1 FOR UPDATE`,
        [input.playerId],
      );
      const playerRow = player.rows[0];
      if (playerRow === undefined) return { kind: "NOT_FOUND" };
      if (playerRow.status !== "ACTIVE") {
        return { kind: "INVALID_STATE", reason: "Pokemon can only be added to an ACTIVE player" };
      }

      const content = await loadActiveContent(client);
      const progression = content?.rulesetConfig.progression?.pokemon;
      if (content === null || progression === undefined) {
        return {
          kind: "INVALID_STATE",
          reason: "Active Pokemon progression rules are unavailable",
        };
      }
      if (input.level > progression.levelCap) {
        return {
          kind: "INVALID_STATE",
          reason: `Requested level exceeds active Pokemon level cap ${progression.levelCap}`,
        };
      }
      const battleRules = content.rulesetConfig.battle;
      if (battleRules.evEnabled) {
        return {
          kind: "INVALID_STATE",
          reason: "Admin Pokemon creation does not yet support EV-enabled rulesets",
        };
      }

      const build = await loadFormBuild(client, content.releaseId, input.formId, input.level);
      if (build === null) return { kind: "NOT_FOUND" };
      const rng = new CounterRandomSource(
        deterministicSeed(
          "pokemon.admin.create.v1",
          input.idempotencyKey,
          input.playerId,
          input.formId,
          String(input.level),
        ),
      );
      const generated = generatePokemonBuild(
        {
          level: input.level,
          baseHp: build.form.base_hp,
          abilityIds: build.abilities,
          natureIds: build.natures.map((nature) => nature.nature_id),
          moves: build.moves,
        },
        rng,
      );
      const nature = build.natures.find((entry) => entry.nature_id === generated.natureId);
      if (nature === undefined) {
        return { kind: "INVALID_STATE", reason: "Generated Nature is missing from active content" };
      }
      const derived = calculatePokemonStats({
        baseStats: baseStats(build.form),
        ivs: generated.ivs,
        level: input.level,
        nature: {
          increasedStat: nature.increased_stat,
          decreasedStat: nature.decreased_stat,
        },
        ivEnabled: battleRules.ivEnabled,
        natureEnabled: battleRules.natureEnabled,
      });
      const placement = await nextRosterPlacement(client, input.playerId);
      const pokemonInstanceId = randomUUID();

      await client.query(
        `INSERT INTO pokemon_instances(
           id, owner_player_id, form_id, level, xp, current_hp, ability_id,
           origin_type, origin_id, metadata
         ) VALUES ($1, $2, $3, $4, 0, $5, $6, 'ADMIN', $7, $8::jsonb)`,
        [
          pokemonInstanceId,
          input.playerId,
          input.formId,
          input.level,
          derived.hp,
          generated.abilityId,
          input.metadata.actorId,
          JSON.stringify({ adminOperationId: input.metadata.sourceId }),
        ],
      );
      await client.query(
        `INSERT INTO pokemon_training_values(
           pokemon_instance_id, nature_id, iv_hp, iv_attack, iv_defense,
           iv_sp_attack, iv_sp_defense, iv_speed
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          pokemonInstanceId,
          generated.natureId,
          generated.ivs.hp,
          generated.ivs.attack,
          generated.ivs.defense,
          generated.ivs.spAttack,
          generated.ivs.spDefense,
          generated.ivs.speed,
        ],
      );
      for (const [index, move] of generated.moves.entries()) {
        await client.query(
          `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
           VALUES ($1, $2, $3, $4)`,
          [pokemonInstanceId, index + 1, move.moveId, move.ppCurrent],
        );
      }
      await client.query(
        `INSERT INTO pokemon_roster_slots(
           pokemon_instance_id, player_id, placement_kind, box_no, slot_no
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          pokemonInstanceId,
          input.playerId,
          placement.placementKind,
          placement.boxNo,
          placement.slotNo,
        ],
      );
      await recordPokedexOwnedByForm(client, input.playerId, input.formId);
      await insertHistory(client, {
        pokemonInstanceId,
        eventType: "ADMIN_CREATED",
        payload: {
          formId: input.formId,
          level: input.level,
          contentReleaseId: content.releaseId,
          rulesetId: content.rulesetId,
          placement,
          reason: input.metadata.reason,
        },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result: PokemonCreateResult = PokemonCreateResultSchema.parse({
        pokemonInstanceId,
        operationKind: "CREATE",
        contentReleaseId: content.releaseId,
        rulesetId: content.rulesetId,
        formId: input.formId,
        level: input.level,
        placement,
        replayed: false,
      });
      await insertClaim(client, {
        operationKind: "CREATE",
        playerId: input.playerId,
        pokemonInstanceId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        beforeData: { exists: false },
        afterData: {
          formId: input.formId,
          level: input.level,
          contentReleaseId: content.releaseId,
          rulesetId: content.rulesetId,
          placement,
          revision: "0",
        },
        result,
        correlationId: input.correlationId,
      });
      return { kind: "APPLIED", result };
    });
  }

  public async correctProgress(
    input: CorrectPokemonProgressInput,
  ): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      expectedRevision: input.expectedRevision.toString(),
      level: input.level,
      xp: input.xp,
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon:${input.pokemonInstanceId}`,
        `pokemon-admin-progress:${input.idempotencyKey}`,
      ]);
      const replay = await client.query<ProgressClaimRow>(
        `SELECT operation_kind, player_id, pokemon_instance_id, request_fingerprint, result
         FROM pokemon_admin_operation_claims
         WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        if (
          replayRow.operation_kind !== "PROGRESSION_CORRECT" ||
          replayRow.player_id !== input.playerId ||
          replayRow.pokemon_instance_id !== input.pokemonInstanceId ||
          replayRow.request_fingerprint !== requestFingerprint
        ) {
          return { kind: "IDEMPOTENCY_CONFLICT" };
        }
        return {
          kind: "REPLAYED",
          result: PokemonOwnerMutationResultSchema.parse(replayRow.result),
        };
      }

      const pokemon = await client.query<PokemonProgressRow>(
        `SELECT instance.revision::text, instance.status, instance.form_id,
                instance.level, instance.xp::text, instance.current_hp,
                training.nature_id, training.iv_hp, training.iv_attack, training.iv_defense,
                training.iv_sp_attack, training.iv_sp_defense, training.iv_speed
         FROM pokemon_instances instance
         JOIN pokemon_training_values training ON training.pokemon_instance_id = instance.id
         WHERE instance.id = $1 AND instance.owner_player_id = $2
         FOR UPDATE OF instance, training`,
        [input.pokemonInstanceId, input.playerId],
      );
      const row = pokemon.rows[0];
      if (row === undefined) return { kind: "NOT_FOUND" };
      const beforeRevision = BigInt(row.revision);
      if (beforeRevision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      if (row.status !== "ACTIVE") {
        return {
          kind: "INVALID_STATE",
          reason: "Archived Pokemon progression cannot be corrected",
        };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }
      const beforeXp = Number(row.xp);
      if (!Number.isSafeInteger(beforeXp)) {
        return {
          kind: "INVALID_STATE",
          reason: "Stored Pokemon XP is outside the safe integer range",
        };
      }
      if (row.level === input.level && beforeXp === input.xp) {
        return { kind: "INVALID_STATE", reason: "Pokemon progression correction would be a no-op" };
      }

      const content = await loadActiveContent(client);
      const progression = content?.rulesetConfig.progression?.pokemon;
      if (content === null || progression === undefined) {
        return {
          kind: "INVALID_STATE",
          reason: "Active Pokemon progression rules are unavailable",
        };
      }
      if (input.level > progression.levelCap) {
        return {
          kind: "INVALID_STATE",
          reason: `Corrected level exceeds active Pokemon level cap ${progression.levelCap}`,
        };
      }
      if (input.level === progression.levelCap) {
        if (input.xp !== 0) {
          return { kind: "INVALID_STATE", reason: "Pokemon at level cap must have zero stored XP" };
        }
      } else if (input.xp >= pokemonXpRequiredForNextLevel(input.level)) {
        return {
          kind: "INVALID_STATE",
          reason: "Corrected XP must remain below the next-level threshold",
        };
      }

      const battleRules = content.rulesetConfig.battle;
      if (battleRules.evEnabled) {
        return {
          kind: "INVALID_STATE",
          reason: "Pokemon progression correction does not support EV-enabled rulesets",
        };
      }
      const form = await client.query<FormBuildRow>(
        `SELECT base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
         FROM pokemon_form_revisions
         WHERE content_release_id = $1 AND form_id = $2 AND active = TRUE`,
        [content.releaseId, row.form_id],
      );
      const formRow = form.rows[0];
      if (formRow === undefined) {
        return { kind: "INVALID_STATE", reason: "Active content cannot derive Pokemon stats" };
      }
      const nature =
        row.nature_id === null
          ? null
          : ((
              await client.query<NatureRow>(
                `SELECT nature_id, increased_stat, decreased_stat
                 FROM nature_revisions
                 WHERE content_release_id = $1 AND nature_id = $2 AND active = TRUE`,
                [content.releaseId, row.nature_id],
              )
            ).rows[0] ?? null);
      if (battleRules.natureEnabled && nature === null) {
        return { kind: "INVALID_STATE", reason: "Active content cannot resolve Pokemon Nature" };
      }
      const ivs = {
        hp: row.iv_hp ?? 0,
        attack: row.iv_attack ?? 0,
        defense: row.iv_defense ?? 0,
        spAttack: row.iv_sp_attack ?? 0,
        spDefense: row.iv_sp_defense ?? 0,
        speed: row.iv_speed ?? 0,
      };
      if (
        battleRules.ivEnabled &&
        [
          row.iv_hp,
          row.iv_attack,
          row.iv_defense,
          row.iv_sp_attack,
          row.iv_sp_defense,
          row.iv_speed,
        ].some((value) => value === null)
      ) {
        return { kind: "INVALID_STATE", reason: "Pokemon IV state is incomplete" };
      }
      const natureEffect = {
        increasedStat: nature?.increased_stat ?? null,
        decreasedStat: nature?.decreased_stat ?? null,
      };
      const oldStats = calculatePokemonStats({
        baseStats: baseStats(formRow),
        ivs,
        level: row.level,
        nature: natureEffect,
        ivEnabled: battleRules.ivEnabled,
        natureEnabled: battleRules.natureEnabled,
      });
      const newStats = calculatePokemonStats({
        baseStats: baseStats(formRow),
        ivs,
        level: input.level,
        nature: natureEffect,
        ivEnabled: battleRules.ivEnabled,
        natureEnabled: battleRules.natureEnabled,
      });
      const afterHp = adjustCurrentHpAfterStatChange({
        currentHp: row.current_hp,
        oldMaxHp: oldStats.hp,
        newMaxHp: newStats.hp,
      });
      const updated = await client.query<{ revision: string }>(
        `UPDATE pokemon_instances
         SET level = $4, xp = $5, current_hp = $6,
             revision = revision + 1, updated_at = now()
         WHERE id = $1 AND owner_player_id = $2 AND revision = $3 AND status = 'ACTIVE'
         RETURNING revision::text`,
        [
          input.pokemonInstanceId,
          input.playerId,
          input.expectedRevision.toString(),
          input.level,
          input.xp,
          afterHp,
        ],
      );
      const afterRevisionRaw = updated.rows[0]?.revision;
      if (afterRevisionRaw === undefined) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      const afterRevision = BigInt(afterRevisionRaw);
      const beforeData = {
        level: row.level,
        xp: beforeXp,
        currentHp: row.current_hp,
        maxHp: oldStats.hp,
        revision: beforeRevision.toString(),
      };
      const afterData = {
        level: input.level,
        xp: input.xp,
        currentHp: afterHp,
        maxHp: newStats.hp,
        revision: afterRevision.toString(),
        sideEffectPolicy: "PRESERVE_HISTORICAL_FORM_AND_MOVES_V1",
      };
      const result = progressResult({
        pokemonInstanceId: input.pokemonInstanceId,
        beforeRevision,
        afterRevision,
        beforeData,
        afterData,
      });
      await insertClaim(client, {
        operationKind: "PROGRESSION_CORRECT",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        beforeData,
        afterData,
        result,
        correlationId: input.correlationId,
      });
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_PROGRESSION_CORRECTED",
        payload: {
          before: beforeData,
          after: afterData,
          contentReleaseId: content.releaseId,
          rulesetId: content.rulesetId,
          reason: input.metadata.reason,
        },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      return { kind: "APPLIED", result };
    });
  }
}
