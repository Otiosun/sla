import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RulesetConfigSchema } from "../../modules/catalog/contracts.js";
import {
  type CorrectPokemonProgressionInput,
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
  type PokemonBaseStats,
  type PokemonIvs,
  type PokemonNatureEffect,
} from "../../modules/pokemon/stats.js";
import { pokemonXpRequiredForNextLevel } from "../../modules/progression/rules.js";
import { withTransaction } from "../db/transaction.js";
import { recordPokedexOwnedByForm } from "../pokedex/postgres-pokedex-writer.js";

type OperationKind = "CREATE" | "PROGRESSION_CORRECT";

interface ExistingClaimRow {
  readonly operation_kind: string;
  readonly player_id: string;
  readonly pokemon_instance_id: string;
  readonly request_fingerprint: string;
  readonly result: unknown;
}

interface PokemonRow {
  readonly revision: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly form_id: string;
  readonly level: number;
  readonly xp: string;
  readonly current_hp: number;
}

interface ActiveBuild {
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly rulesetConfig: unknown;
  readonly baseStats: PokemonBaseStats;
  readonly nature: PokemonNatureEffect;
  readonly ivs: PokemonIvs;
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
    (input.pokemonInstanceId !== undefined &&
      row.pokemon_instance_id !== input.pokemonInstanceId) ||
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
     ORDER BY slot_no
     FOR UPDATE`,
    [playerId],
  );
  const occupied = new Set(team.rows.map((row) => row.slot_no));
  for (let slot = 1; slot <= 6; slot += 1) {
    if (!occupied.has(slot)) return { placementKind: "TEAM", boxNo: null, slotNo: slot };
  }
  const box = await client.query<{ next_slot: number }>(
    `SELECT COALESCE(MAX(slot_no), 0) + 1 AS next_slot
     FROM pokemon_roster_slots
     WHERE player_id = $1 AND placement_kind = 'BOX' AND box_no = 1`,
    [playerId],
  );
  return { placementKind: "BOX", boxNo: 1, slotNo: box.rows[0]?.next_slot ?? 1 };
}

function validateLevelXp(
  level: number,
  xp: number,
  levelCap: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (level > levelCap) {
    return { ok: false, reason: `Pokemon level cannot exceed active level cap ${levelCap}` };
  }
  if (level === levelCap) {
    return xp === 0
      ? { ok: true }
      : { ok: false, reason: "Pokemon at level cap must have zero in-level XP" };
  }
  const threshold = pokemonXpRequiredForNextLevel(level);
  return xp < threshold
    ? { ok: true }
    : { ok: false, reason: `Pokemon XP must be below next-level threshold ${threshold}` };
}

function allZeroIvs(ivs: PokemonIvs): boolean {
  return Object.values(ivs).every((value) => value === 0);
}

async function loadCreateContent(
  client: PoolClient,
  formId: string,
  natureId: string | null,
): Promise<ActiveBuild | null> {
  const query = await client.query<{
    content_release_id: string;
    ruleset_id: string;
    ruleset_config: unknown;
    base_hp: number;
    base_attack: number;
    base_defense: number;
    base_sp_attack: number;
    base_sp_defense: number;
    base_speed: number;
    increased_stat: PokemonNatureEffect["increasedStat"];
    decreased_stat: PokemonNatureEffect["decreasedStat"];
  }>(
    `SELECT release.id AS content_release_id, ruleset.id AS ruleset_id,
            ruleset.config AS ruleset_config,
            form.base_hp, form.base_attack, form.base_defense,
            form.base_sp_attack, form.base_sp_defense, form.base_speed,
            nature.increased_stat, nature.decreased_stat
     FROM content_release_pointers pointer
     JOIN content_releases release
       ON release.id = pointer.content_release_id AND release.status = 'PUBLISHED'
     JOIN rulesets ruleset
       ON ruleset.id = release.default_ruleset_id AND ruleset.status = 'PUBLISHED'
     JOIN pokemon_form_revisions form
       ON form.content_release_id = release.id AND form.form_id = $1 AND form.active = TRUE
     LEFT JOIN nature_revisions nature
       ON nature.content_release_id = release.id AND nature.nature_id = $2 AND nature.active = TRUE
     WHERE pointer.pointer_key = 'ACTIVE'`,
    [formId, natureId],
  );
  const row = query.rows[0];
  if (row === undefined) return null;
  return {
    contentReleaseId: row.content_release_id,
    rulesetId: row.ruleset_id,
    rulesetConfig: row.ruleset_config,
    baseStats: {
      hp: row.base_hp,
      attack: row.base_attack,
      defense: row.base_defense,
      spAttack: row.base_sp_attack,
      spDefense: row.base_sp_defense,
      speed: row.base_speed,
    },
    nature: {
      increasedStat: row.increased_stat ?? null,
      decreasedStat: row.decreased_stat ?? null,
    },
    ivs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
  };
}

async function loadPokemon(
  client: PoolClient,
  playerId: string,
  pokemonInstanceId: string,
): Promise<PokemonRow | null> {
  const query = await client.query<PokemonRow>(
    `SELECT revision::text, status, form_id, level, xp::text, current_hp
     FROM pokemon_instances
     WHERE id = $1 AND owner_player_id = $2
     FOR UPDATE`,
    [pokemonInstanceId, playerId],
  );
  return query.rows[0] ?? null;
}

async function loadActiveBuildForPokemon(
  client: PoolClient,
  playerId: string,
  pokemonInstanceId: string,
): Promise<ActiveBuild | null> {
  const query = await client.query<{
    content_release_id: string;
    ruleset_id: string;
    ruleset_config: unknown;
    base_hp: number;
    base_attack: number;
    base_defense: number;
    base_sp_attack: number;
    base_sp_defense: number;
    base_speed: number;
    nature_id: string | null;
    increased_stat: PokemonNatureEffect["increasedStat"];
    decreased_stat: PokemonNatureEffect["decreasedStat"];
    iv_hp: number | null;
    iv_attack: number | null;
    iv_defense: number | null;
    iv_sp_attack: number | null;
    iv_sp_defense: number | null;
    iv_speed: number | null;
  }>(
    `SELECT release.id AS content_release_id, ruleset.id AS ruleset_id,
            ruleset.config AS ruleset_config,
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
  return {
    contentReleaseId: row.content_release_id,
    rulesetId: row.ruleset_id,
    rulesetConfig: row.ruleset_config,
    baseStats: {
      hp: row.base_hp,
      attack: row.base_attack,
      defense: row.base_defense,
      spAttack: row.base_sp_attack,
      spDefense: row.base_sp_defense,
      speed: row.base_speed,
    },
    nature: {
      increasedStat: row.increased_stat ?? null,
      decreasedStat: row.decreased_stat ?? null,
    },
    ivs: {
      hp: row.iv_hp ?? 0,
      attack: row.iv_attack ?? 0,
      defense: row.iv_defense ?? 0,
      spAttack: row.iv_sp_attack ?? 0,
      spDefense: row.iv_sp_defense ?? 0,
      speed: row.iv_speed ?? 0,
    },
  };
}

function derivedMaxHp(
  build: ActiveBuild,
  level: number,
  ivEnabled: boolean,
  natureEnabled: boolean,
): number {
  return calculatePokemonStats({
    baseStats: build.baseStats,
    ivs: build.ivs,
    level,
    nature: build.nature,
    ivEnabled,
    natureEnabled,
  }).hp;
}

export class PostgresPokemonLifecycleAdminRepository implements PokemonLifecycleAdminRepository {
  public constructor(private readonly pool: Pool) {}

  public async createPokemon(input: CreatePokemonInput): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      operationKind: "CREATE",
      playerId: input.playerId,
      formId: input.formId,
      level: input.level,
      xp: input.xp,
      abilityId: input.abilityId,
      natureId: input.natureId,
      ivs: input.ivs,
      moveIds: input.moveIds,
      nickname: input.nickname,
      shiny: input.shiny,
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `pokemon-admin-key:${input.idempotencyKey}`,
        `pokemon-roster:${input.playerId}`,
      ]);
      const replay = await loadClaim(client, {
        idempotencyKey: input.idempotencyKey,
        operationKind: "CREATE",
        playerId: input.playerId,
        requestFingerprint,
      });
      if (replay !== null) return replay;

      const player = await client.query<{ status: string; onboarding_state: string | null }>(
        `SELECT player.status, onboarding.state AS onboarding_state
         FROM players player
         LEFT JOIN onboarding_states onboarding ON onboarding.player_id = player.id
         WHERE player.id = $1
         FOR UPDATE OF player`,
        [input.playerId],
      );
      const playerRow = player.rows[0];
      if (playerRow === undefined) return { kind: "NOT_FOUND" };
      if (playerRow.status !== "ACTIVE" || playerRow.onboarding_state !== "COMPLETE") {
        return {
          kind: "INVALID_STATE",
          reason: "Pokemon can only be administratively created for an active, onboarded player",
        };
      }

      const build = await loadCreateContent(client, input.formId, input.natureId);
      if (build === null) {
        return {
          kind: "INVALID_STATE",
          reason: "Active content does not expose the requested form",
        };
      }
      const parsedRules = RulesetConfigSchema.safeParse(build.rulesetConfig);
      if (!parsedRules.success || parsedRules.data.progression === undefined) {
        return {
          kind: "INVALID_STATE",
          reason: "Active ruleset has no valid Pokemon progression policy",
        };
      }
      const battle = parsedRules.data.battle;
      const progression = parsedRules.data.progression.pokemon;
      const levelXp = validateLevelXp(input.level, input.xp, progression.levelCap);
      if (!levelXp.ok) return { kind: "INVALID_STATE", reason: levelXp.reason };
      if (!battle.ivEnabled && !allZeroIvs(input.ivs)) {
        return {
          kind: "INVALID_STATE",
          reason: "Disabled IV rules require zeroed administrative IVs",
        };
      }
      if (battle.natureEnabled && input.natureId === null) {
        return { kind: "INVALID_STATE", reason: "Active ruleset requires a Nature" };
      }
      if (!battle.natureEnabled && input.natureId !== null) {
        return { kind: "INVALID_STATE", reason: "Disabled Nature rules require natureId=null" };
      }
      if (
        battle.natureEnabled &&
        build.nature.increasedStat === null &&
        build.nature.decreasedStat === null
      ) {
        const neutralNature = await client.query(
          `SELECT 1 FROM nature_revisions
           WHERE content_release_id = $1 AND nature_id = $2 AND active = TRUE
           LIMIT 1`,
          [build.contentReleaseId, input.natureId],
        );
        if (neutralNature.rowCount !== 1) {
          return {
            kind: "INVALID_STATE",
            reason: "Requested Nature is not active in current content",
          };
        }
      }

      const ability = await client.query(
        `SELECT 1
         FROM pokemon_form_ability_options option
         JOIN ability_revisions revision
           ON revision.content_release_id = option.content_release_id
          AND revision.ability_id = option.ability_id
          AND revision.active = TRUE
         WHERE option.content_release_id = $1 AND option.form_id = $2
           AND option.ability_id = $3 AND option.active = TRUE
         LIMIT 1`,
        [build.contentReleaseId, input.formId, input.abilityId],
      );
      if (ability.rowCount !== 1) {
        return { kind: "INVALID_STATE", reason: "Requested Ability is not valid for this form" };
      }

      const moves: { readonly moveId: string; readonly ppCurrent: number | null }[] = [];
      for (const moveId of input.moveIds) {
        const move = await client.query<{ max_pp: number | null }>(
          `SELECT revision.max_pp
           FROM move_revisions revision
           WHERE revision.content_release_id = $1 AND revision.move_id = $2
             AND revision.active = TRUE
             AND EXISTS (
               SELECT 1 FROM move_learnset_entries learnset
               WHERE learnset.content_release_id = $1 AND learnset.form_id = $3
                 AND learnset.move_id = $2 AND learnset.active = TRUE
                 AND (
                   learnset.learn_method = 'START'
                   OR (learnset.learn_method = 'LEVEL' AND learnset.learn_level <= $4)
                 )
             )`,
          [build.contentReleaseId, moveId, input.formId, input.level],
        );
        const row = move.rows[0];
        if (row === undefined || (battle.ppEnabled && row.max_pp === null)) {
          return {
            kind: "INVALID_STATE",
            reason: "Requested move is not active/learnable for this form and level",
          };
        }
        moves.push({ moveId, ppCurrent: battle.ppEnabled ? row.max_pp : null });
      }

      const stats = calculatePokemonStats({
        baseStats: build.baseStats,
        ivs: input.ivs,
        level: input.level,
        nature: build.nature,
        ivEnabled: battle.ivEnabled,
        natureEnabled: battle.natureEnabled,
      });
      const placement = await nextRosterPlacement(client, input.playerId);
      const pokemonInstanceId = randomUUID();
      await client.query(
        `INSERT INTO pokemon_instances(
           id, owner_player_id, form_id, nickname, level, xp, current_hp, shiny,
           ability_id, origin_type, origin_id, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   $9, 'ADMIN_OPERATION', $10::uuid, $11::jsonb)`,
        [
          pokemonInstanceId,
          input.playerId,
          input.formId,
          input.nickname,
          input.level,
          input.xp,
          stats.hp,
          input.shiny,
          input.abilityId,
          input.metadata.sourceId,
          JSON.stringify({ adminCreated: true, sourceId: input.metadata.sourceId }),
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
      for (const [index, move] of moves.entries()) {
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

      const beforeData = { exists: false };
      const afterData = {
        exists: true,
        formId: input.formId,
        level: input.level,
        xp: input.xp,
        currentHp: stats.hp,
        maxHp: stats.hp,
        abilityId: input.abilityId,
        natureId: input.natureId,
        ivs: input.ivs,
        moveIds: input.moveIds,
        nickname: input.nickname,
        shiny: input.shiny,
        placement,
        contentReleaseId: build.contentReleaseId,
        rulesetId: build.rulesetId,
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
        beforeRevision: 0n,
        afterRevision: 0n,
        beforeData,
        afterData,
      });
      await insertClaim(client, {
        operationKind: "CREATE",
        playerId: input.playerId,
        pokemonInstanceId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        beforeData,
        afterData,
        result,
        correlationId: input.correlationId,
      });
      return { kind: "APPLIED", result };
    });
  }

  public async correctProgression(
    input: CorrectPokemonProgressionInput,
  ): Promise<PokemonAdminPersistenceResult> {
    const requestFingerprint = fingerprint({
      operationKind: "PROGRESSION_CORRECT",
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      expectedRevision: input.expectedRevision.toString(),
      targetLevel: input.targetLevel,
      targetXp: input.targetXp,
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
        operationKind: "PROGRESSION_CORRECT",
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
        return {
          kind: "INVALID_STATE",
          reason: "Archived Pokemon progression cannot be corrected",
        };
      }
      if (await hasUnsafeBattleReference(client, input.pokemonInstanceId)) {
        return { kind: "ACTIVE_BATTLE" };
      }

      const build = await loadActiveBuildForPokemon(
        client,
        input.playerId,
        input.pokemonInstanceId,
      );
      if (build === null) {
        return {
          kind: "INVALID_STATE",
          reason: "Active content cannot derive this Pokemon progression safely",
        };
      }
      const parsedRules = RulesetConfigSchema.safeParse(build.rulesetConfig);
      if (!parsedRules.success || parsedRules.data.progression === undefined) {
        return {
          kind: "INVALID_STATE",
          reason: "Active ruleset has no valid Pokemon progression policy",
        };
      }
      const battle = parsedRules.data.battle;
      const progression = parsedRules.data.progression.pokemon;
      const levelXp = validateLevelXp(input.targetLevel, input.targetXp, progression.levelCap);
      if (!levelXp.ok) return { kind: "INVALID_STATE", reason: levelXp.reason };

      const beforeXp = Number(pokemon.xp);
      if (!Number.isSafeInteger(beforeXp)) {
        return {
          kind: "INVALID_STATE",
          reason: "Persisted Pokemon XP is outside the safe runtime range",
        };
      }
      if (pokemon.level === input.targetLevel && beforeXp === input.targetXp) {
        return {
          kind: "INVALID_STATE",
          reason: "Pokemon already has the requested progression state",
        };
      }
      if (input.targetLevel < pokemon.level) {
        const pending = await client.query(
          `SELECT 1 FROM pending_move_choices
           WHERE pokemon_instance_id = $1 AND status = 'PENDING' AND learn_level > $2
           LIMIT 1`,
          [input.pokemonInstanceId, input.targetLevel],
        );
        if (pending.rowCount === 1) {
          return {
            kind: "INVALID_STATE",
            reason:
              "Resolve or skip pending move choices above the target level before lowering level",
          };
        }
      }

      const oldMaxHp = derivedMaxHp(build, pokemon.level, battle.ivEnabled, battle.natureEnabled);
      const newMaxHp = derivedMaxHp(
        build,
        input.targetLevel,
        battle.ivEnabled,
        battle.natureEnabled,
      );
      const correctedHp = adjustCurrentHpAfterStatChange({
        currentHp: pokemon.current_hp,
        oldMaxHp,
        newMaxHp,
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
          input.targetLevel,
          input.targetXp,
          correctedHp,
        ],
      );
      const afterRevisionRaw = updated.rows[0]?.revision;
      if (afterRevisionRaw === undefined) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }
      const afterRevision = BigInt(afterRevisionRaw);
      const beforeData = {
        formId: pokemon.form_id,
        level: pokemon.level,
        xp: beforeXp,
        currentHp: pokemon.current_hp,
        maxHp: oldMaxHp,
        revision: beforeRevision.toString(),
      };
      const afterData = {
        formId: pokemon.form_id,
        level: input.targetLevel,
        xp: input.targetXp,
        currentHp: correctedHp,
        maxHp: newMaxHp,
        contentReleaseId: build.contentReleaseId,
        rulesetId: build.rulesetId,
        revision: afterRevision.toString(),
        sideEffects: {
          moves: "PRESERVED",
          evolution: "PRESERVED",
          pokedex: "PRESERVED",
        },
      };
      await insertHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "ADMIN_PROGRESSION_CORRECTED",
        payload: {
          before: beforeData,
          after: afterData,
          rewardLedgerPolicy: "ADMIN_CORRECTION_NOT_REWARD",
          reason: input.metadata.reason,
        },
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
        correlationId: input.correlationId,
      });
      const result = mutationResult({
        pokemonInstanceId: input.pokemonInstanceId,
        operationKind: "PROGRESSION_CORRECT",
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
      return { kind: "APPLIED", result };
    });
  }
}
