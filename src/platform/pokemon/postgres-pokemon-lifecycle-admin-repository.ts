import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RulesetConfigSchema, type RulesetConfig } from "../../modules/catalog/contracts.js";
import {
  type CorrectPokemonProgressInput,
  type CreatePokemonInput,
  PokemonOwnerMutationResultSchema,
  type PokemonOwnerMutationResult,
  type PokemonRosterPlacement,
} from "../../modules/pokemon/admin-contracts.js";
import type { PokemonAdminPersistenceResult } from "../../modules/pokemon/admin-ports.js";
import type { PokemonLifecycleAdminRepository } from "../../modules/pokemon/lifecycle-admin-ports.js";
import {
  adjustCurrentHpAfterStatChange,
  calculatePokemonStats,
} from "../../modules/pokemon/stats.js";
import { withTransaction } from "../db/transaction.js";
import { recordPokedexOwnedByForm } from "../pokedex/postgres-pokedex-writer.js";

type LifecycleOperationKind = "CREATE" | "PROGRESS_CORRECT";

interface ExistingClaimRow {
  readonly operation_kind: string;
  readonly player_id: string;
  readonly pokemon_instance_id: string;
  readonly request_fingerprint: string;
  readonly result: unknown;
}

interface ActiveRules {
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly config: RulesetConfig;
}

interface MechanicalBuild {
  readonly speciesId: string;
  readonly maxHp: number;
  readonly movePp: readonly (number | null)[];
}

interface ProgressPokemonRow {
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
    readonly operationKind: LifecycleOperationKind;
    readonly playerId: string;
    readonly pokemonInstanceId?: string;
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
    (input.pokemonInstanceId !== undefined && row.pokemon_instance_id !== input.pokemonInstanceId) ||
    row.request_fingerprint !== input.requestFingerprint
  ) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  return { kind: "REPLAYED", result: PokemonOwnerMutationResultSchema.parse(row.result) };
}

async function insertClaim(
  client: PoolClient,
  input: {
    readonly operationKind: LifecycleOperationKind;
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

async function loadActiveRules(client: PoolClient): Promise<ActiveRules | null> {
  const result = await client.query<{
    content_release_id: string;
    ruleset_id: string;
    config: unknown;
  }>(
    `SELECT release.id AS content_release_id, ruleset.id AS ruleset_id, ruleset.config
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
  return {
    contentReleaseId: row.content_release_id,
    rulesetId: row.ruleset_id,
    config: parsed.data,
  };
}

async function nextRosterPlacement(
  client: PoolClient,
  playerId: string,
): Promise<PokemonRosterPlacement> {
  const team = await client.query<{ slot_no: number }>(
    `SELECT slot_no FROM pokemon_roster_slots
     WHERE player_id = $1 AND placement_kind = 'TEAM'
     ORDER BY slot_no FOR UPDATE`,
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

async function validateMechanicalBuild(
  client: PoolClient,
  input: {
    readonly rules: ActiveRules;
    readonly formId: string;
    readonly level: number;
    readonly natureId: string;
    readonly abilityId: string;
    readonly ivs: CreatePokemonInput["ivs"];
    readonly moveIds: readonly string[];
  },
): Promise<MechanicalBuild | null> {
  const battle = input.rules.config.battle;
  if (battle.evEnabled) return null;

  const form = await client.query<{
    species_id: string;
    base_hp: number;
    base_attack: number;
    base_defense: number;
    base_sp_attack: number;
    base_sp_defense: number;
    base_speed: number;
  }>(
    `SELECT identity.species_id, revision.base_hp, revision.base_attack, revision.base_defense,
            revision.base_sp_attack, revision.base_sp_defense, revision.base_speed
     FROM pokemon_forms identity
     JOIN pokemon_form_revisions revision
       ON revision.form_id = identity.id AND revision.content_release_id = $1
     JOIN pokemon_species_revisions species
       ON species.species_id = identity.species_id
      AND species.content_release_id = $1 AND species.active = TRUE
     WHERE identity.id = $2 AND revision.active = TRUE`,
    [input.rules.contentReleaseId, input.formId],
  );
  const formRow = form.rows[0];
  if (formRow === undefined) return null;

  const nature = await client.query<{
    increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
    decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  }>(
    `SELECT increased_stat, decreased_stat
     FROM nature_revisions
     WHERE content_release_id = $1 AND nature_id = $2 AND active = TRUE`,
    [input.rules.contentReleaseId, input.natureId],
  );
  const natureRow = nature.rows[0];
  if (natureRow === undefined) return null;

  const ability = await client.query(
    `SELECT 1
     FROM pokemon_form_ability_options option
     JOIN ability_revisions revision
       ON revision.content_release_id = option.content_release_id
      AND revision.ability_id = option.ability_id AND revision.active = TRUE
     WHERE option.content_release_id = $1 AND option.form_id = $2
       AND option.ability_id = $3 AND option.active = TRUE
     LIMIT 1`,
    [input.rules.contentReleaseId, input.formId, input.abilityId],
  );
  if (ability.rowCount !== 1) return null;

  const moves = await client.query<{ move_id: string; max_pp: number | null }>(
    `SELECT revision.move_id, revision.max_pp
     FROM move_revisions revision
     WHERE revision.content_release_id = $1
       AND revision.move_id = ANY($2::uuid[])
       AND revision.active = TRUE
       AND EXISTS (
         SELECT 1 FROM move_learnset_entries learnset
         WHERE learnset.content_release_id = revision.content_release_id
           AND learnset.form_id = $3
           AND learnset.move_id = revision.move_id
           AND learnset.active = TRUE
           AND (
             learnset.learn_method = 'START'
             OR (learnset.learn_method = 'LEVEL' AND learnset.learn_level <= $4)
           )
       )`,
    [input.rules.contentReleaseId, input.moveIds, input.formId, input.level],
  );
  if (moves.rows.length !== input.moveIds.length) return null;
  const ppByMove = new Map(moves.rows.map((row) => [row.move_id, row.max_pp]));
  const movePp = input.moveIds.map((moveId) => ppByMove.get(moveId) ?? null);
  if (battle.ppEnabled && movePp.some((pp) => pp === null)) return null;

  const stats = calculatePokemonStats({
    baseStats: {
      hp: formRow.base_hp,
      attack: formRow.base_attack,
      defense: formRow.base_defense,
      spAttack: formRow.base_sp_attack,
      spDefense: formRow.base_sp_defense,
      speed: formRow.base_speed,
    },
    ivs: input.ivs,
    level: input.level,
    nature: {
      increasedStat: natureRow.increased_stat,
      decreasedStat: natureRow.decreased_stat,
    },
    ivEnabled: battle.ivEnabled,
    natureEnabled: battle.natureEnabled,
  });
  return { speciesId: formRow.species_id, maxHp: stats.hp, movePp };
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

function cumulativeXp(level: number, levelXp: number): number {
  return level ** 3 - 1 + levelXp;
}

function levelAndXpForTotal(totalXp: number, levelCap: number): { level: number; xp: number } {
  for (let level = levelCap; level >= 1; level -= 1) {
    const base = level ** 3 - 1;
    if (totalXp >= base) {
      return { level, xp: level === levelCap ? 0 : totalXp - base };
    }
  }
  return { level: 1, xp: 0 };
}

function mutationResult(input: {
  readonly pokemonInstanceId: string;
  readonly operationKind: LifecycleOperationKind;
  readonly beforeRevision: bigint | null;
  readonly afterRevision: bigint;
  readonly beforeData: Readonly<Record<string, unknown>>;
  readonly afterData: Readonly<Record<string, unknown>>;
}): PokemonOwnerMutationResult {
  return PokemonOwnerMutationResultSchema.parse({
    pokemonInstanceId: input.pokemonInstanceId,
    operationKind: input.operationKind,
    beforeRevision: input.beforeRevision === null ? null : input.beforeRevision.toString(),
    afterRevision: input.afterRevision.toString(),
    beforeData: input.beforeData,
    afterData: input.afterData,
    replayed: false,
  });
}

export class PostgresPokemonLifecycleAdminRepository implements PokemonLifecycleAdminRepository {
  public constructor(private readonly pool: Pool) {}

  public async createPokemon(input: CreatePokemonInput): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      operationKind: "CREATE",
      playerId: input.playerId,
      formId: input.formId,
      level: input.level,
      natureId: input.natureId,
      abilityId: input.abilityId,
      ivs: input.ivs,
      moveIds: input.moveIds,
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon-admin-key:${input.idempotencyKey}`,
        `pokemon-create:${input.playerId}`,
      ]);
      const replay = await loadClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "CREATE",
        playerId: input.playerId,
        requestFingerprint,
      });
      if (replay !== null) return replay;

      const player = await client.query<{ status: string }>(
        `SELECT status FROM players WHERE id = $1 FOR UPDATE`,
        [input.playerId],
      );
      if (player.rows[0]?.status !== "ACTIVE") return { kind: "NOT_FOUND" };
      const rules = await loadActiveRules(client);
      if (rules === null) {
        return { kind: "INVALID_STATE", reason: "No valid ACTIVE content release is available" };
      }
      const progression = rules.config.progression?.pokemon;
      if (progression === undefined || input.level > progression.levelCap) {
        return { kind: "INVALID_STATE", reason: "Requested level is outside active progression rules" };
      }
      const build = await validateMechanicalBuild(client, {
        rules,
        formId: input.formId,
        level: input.level,
        natureId: input.natureId,
        abilityId: input.abilityId,
        ivs: input.ivs,
        moveIds: input.moveIds,
      });
      if (build === null) {
        return {
          kind: "INVALID_STATE",
          reason: "Requested Pokemon build is not valid in the ACTIVE content release",
        };
      }
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
          build.maxHp,
          input.abilityId,
          input.metadata.actorId,
          JSON.stringify({
            adminSourceType: input.metadata.sourceType,
            adminSourceId: input.metadata.sourceId,
            contentReleaseId: rules.contentReleaseId,
            rulesetId: rules.rulesetId,
          }),
        ],
      );
      await client.query(
        `INSERT INTO pokemon_training_values(
           pokemon_instance_id, nature_id, iv_hp, iv_attack, iv_defense,
           iv_sp_attack, iv_sp_defense, iv_speed
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          pokemonInstanceId,
          input.natureId,
          input.ivs.hp,
          input.ivs.attack,
          input.ivs.defense,
          input.ivs.spAttack,
          input.ivs.spDefense,
          input.ivs.speed,
        ],
      );
      for (const [index, moveId] of input.moveIds.entries()) {
        await client.query(
          `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
           VALUES ($1, $2, $3, $4)`,
          [pokemonInstanceId, index + 1, moveId, build.movePp[index] ?? null],
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
      const beforeData = { exists: false };
      const afterData = {
        exists: true,
        formId: input.formId,
        level: input.level,
        xp: 0,
        currentHp: build.maxHp,
        natureId: input.natureId,
        abilityId: input.abilityId,
        ivs: input.ivs,
        moveIds: input.moveIds,
        placement,
        contentReleaseId: rules.contentReleaseId,
        rulesetId: rules.rulesetId,
        revision: "0",
      };
      await insertHistory(client, {
        pokemonInstanceId,
        eventType: "ADMIN_CREATED",
        payload: { ...afterData, reason: input.metadata.reason },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId,
        operationKind: "CREATE",
        beforeRevision: null,
        afterRevision: 0n,
        beforeData,
        afterData,
      });
      if (
        !(await insertClaim(client, {
          operationKind: "CREATE",
          playerId: input.playerId,
          pokemonInstanceId,
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

  public async correctProgress(
    input: CorrectPokemonProgressInput,
  ): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      operationKind: "PROGRESS_CORRECT",
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      expectedRevision: input.expectedRevision.toString(),
      deltaXp: input.deltaXp,
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon:${input.pokemonInstanceId}`,
        `pokemon-admin-key:${input.idempotencyKey}`,
      ]);
      const replay = await loadClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "PROGRESS_CORRECT",
        playerId: input.playerId,
        pokemonInstanceId: input.pokemonInstanceId,
        requestFingerprint,
      });
      if (replay !== null) return replay;

      const pokemon = await client.query<ProgressPokemonRow>(
        `SELECT instance.revision::text, instance.status, instance.form_id, instance.level,
                instance.xp::text, instance.current_hp, training.nature_id,
                training.iv_hp, training.iv_attack, training.iv_defense,
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
        return { kind: "INVALID_STATE", reason: "Archived Pokemon progression cannot be corrected" };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }
      const rules = await loadActiveRules(client);
      const pokemonRules = rules?.config.progression?.pokemon;
      if (rules === null || pokemonRules === undefined || pokemonRules.xpCurve !== "CUBIC_DELTA_V1") {
        return { kind: "INVALID_STATE", reason: "Active Pokemon progression rules are unsupported" };
      }
      if (rules.config.battle.evEnabled) {
        return { kind: "INVALID_STATE", reason: "EV-enabled progress correction is not supported" };
      }
      if (row.level > pokemonRules.levelCap) {
        return { kind: "INVALID_STATE", reason: "Stored Pokemon level exceeds active level cap" };
      }
      const beforeXp = Number(row.xp);
      if (!Number.isSafeInteger(beforeXp) || beforeXp < 0) {
        return { kind: "INVALID_STATE", reason: "Stored Pokemon XP is outside the safe range" };
      }
      const currentThreshold = row.level === pokemonRules.levelCap
        ? 0
        : (row.level + 1) ** 3 - row.level ** 3;
      if ((row.level === pokemonRules.levelCap && beforeXp !== 0) || (row.level < pokemonRules.levelCap && beforeXp >= currentThreshold)) {
        return { kind: "INVALID_STATE", reason: "Stored Pokemon level/XP state is incoherent" };
      }
      const beforeTotalXp = cumulativeXp(row.level, beforeXp);
      const maxTotalXp = pokemonRules.levelCap ** 3 - 1;
      const afterTotalXp = beforeTotalXp + input.deltaXp;
      if (!Number.isSafeInteger(afterTotalXp) || afterTotalXp < 0 || afterTotalXp > maxTotalXp) {
        return { kind: "INVALID_STATE", reason: "Pokemon progress correction exceeds valid XP bounds" };
      }
      const target = levelAndXpForTotal(afterTotalXp, pokemonRules.levelCap);
      if (row.nature_id === null) {
        return { kind: "INVALID_STATE", reason: "Pokemon has no persisted Nature" };
      }
      const ivs = {
        hp: row.iv_hp,
        attack: row.iv_attack,
        defense: row.iv_defense,
        spAttack: row.iv_sp_attack,
        spDefense: row.iv_sp_defense,
        speed: row.iv_speed,
      };
      if (Object.values(ivs).some((value) => value === null)) {
        return { kind: "INVALID_STATE", reason: "Pokemon has incomplete IV state" };
      }
      const buildBefore = await validateMechanicalBuild(client, {
        rules,
        formId: row.form_id,
        level: row.level,
        natureId: row.nature_id,
        abilityId: await client
          .query<{ ability_id: string | null }>(`SELECT ability_id FROM pokemon_instances WHERE id = $1`, [input.pokemonInstanceId])
          .then((result) => result.rows[0]?.ability_id ?? ""),
        ivs: {
          hp: row.iv_hp ?? 0,
          attack: row.iv_attack ?? 0,
          defense: row.iv_defense ?? 0,
          spAttack: row.iv_sp_attack ?? 0,
          spDefense: row.iv_sp_defense ?? 0,
          speed: row.iv_speed ?? 0,
        },
        moveIds: await client
          .query<{ move_id: string }>(
            `SELECT move_id FROM pokemon_move_slots WHERE pokemon_instance_id = $1 ORDER BY slot_no`,
            [input.pokemonInstanceId],
          )
          .then((result) => result.rows.map((move) => move.move_id)),
      });
      if (buildBefore === null) {
        return { kind: "INVALID_STATE", reason: "Current Pokemon build is invalid in ACTIVE content" };
      }
      const nature = await client.query<{
        increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
        decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
        base_hp: number;
        base_attack: number;
        base_defense: number;
        base_sp_attack: number;
        base_sp_defense: number;
        base_speed: number;
      }>(
        `SELECT nature.increased_stat, nature.decreased_stat,
                form.base_hp, form.base_attack, form.base_defense,
                form.base_sp_attack, form.base_sp_defense, form.base_speed
         FROM nature_revisions nature
         JOIN pokemon_form_revisions form
           ON form.content_release_id = nature.content_release_id AND form.form_id = $3 AND form.active = TRUE
         WHERE nature.content_release_id = $1 AND nature.nature_id = $2 AND nature.active = TRUE`,
        [rules.contentReleaseId, row.nature_id, row.form_id],
      );
      const mechanical = nature.rows[0];
      if (mechanical === undefined) {
        return { kind: "INVALID_STATE", reason: "Active content cannot recalculate Pokemon stats" };
      }
      const typedIvs = {
        hp: row.iv_hp ?? 0,
        attack: row.iv_attack ?? 0,
        defense: row.iv_defense ?? 0,
        spAttack: row.iv_sp_attack ?? 0,
        spDefense: row.iv_sp_defense ?? 0,
        speed: row.iv_speed ?? 0,
      };
      const baseStats = {
        hp: mechanical.base_hp,
        attack: mechanical.base_attack,
        defense: mechanical.base_defense,
        spAttack: mechanical.base_sp_attack,
        spDefense: mechanical.base_sp_defense,
        speed: mechanical.base_speed,
      };
      const natureValue = {
        increasedStat: mechanical.increased_stat,
        decreasedStat: mechanical.decreased_stat,
      };
      const oldStats = calculatePokemonStats({
        baseStats,
        ivs: typedIvs,
        level: row.level,
        nature: natureValue,
        ivEnabled: rules.config.battle.ivEnabled,
        natureEnabled: rules.config.battle.natureEnabled,
      });
      const newStats = calculatePokemonStats({
        baseStats,
        ivs: typedIvs,
        level: target.level,
        nature: natureValue,
        ivEnabled: rules.config.battle.ivEnabled,
        natureEnabled: rules.config.battle.natureEnabled,
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
         WHERE id = $1 AND owner_player_id = $2 AND status = 'ACTIVE' AND revision = $3
         RETURNING revision::text`,
        [
          input.pokemonInstanceId,
          input.playerId,
          input.expectedRevision.toString(),
          target.level,
          target.xp,
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
        cumulativeXp: beforeTotalXp,
        currentHp: row.current_hp,
        maxHp: oldStats.hp,
        formId: row.form_id,
        revision: beforeRevision.toString(),
      };
      const afterData = {
        level: target.level,
        xp: target.xp,
        cumulativeXp: afterTotalXp,
        currentHp: afterHp,
        maxHp: newStats.hp,
        formId: row.form_id,
        preservedFormAndMoves: true,
        revision: afterRevision.toString(),
      };
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_PROGRESS_CORRECTED",
        payload: {
          deltaXp: input.deltaXp,
          before: beforeData,
          after: afterData,
          sideEffectPolicy: "PRESERVE_FORM_AND_MOVES_V1",
          reason: input.metadata.reason,
        },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId: input.pokemonInstanceId,
        operationKind: "PROGRESS_CORRECT",
        beforeRevision,
        afterRevision,
        beforeData,
        afterData,
      });
      if (
        !(await insertClaim(client, {
          operationKind: "PROGRESS_CORRECT",
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
