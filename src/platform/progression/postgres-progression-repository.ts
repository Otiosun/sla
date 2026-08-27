import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type BattleCombatant,
  type BattleState,
  BattleStateSchema,
} from "../../modules/battle/contracts.js";
import {
  EvolutionTriggerSchemas,
  type ProgressionRules,
  type RulesetConfig,
  RulesetConfigSchema,
} from "../../modules/catalog/contracts.js";
import {
  adjustCurrentHpAfterStatChange,
  calculatePokemonStats,
  type PokemonBaseStats,
} from "../../modules/pokemon/stats.js";
import {
  type ApplyBattleRewardInput,
  BattleRewardResultSchema,
  type EvolutionResult,
  EvolutionResultSchema,
  type EvolvePokemonInput,
  MoveChoiceResultSchema,
  type PokemonXpAwardResult,
  type ResolveMoveChoiceInput,
  type TrainerProgressResult,
} from "../../modules/progression/contracts.js";
import type {
  BattleRewardPersistenceResult,
  EvolutionPersistenceResult,
  MoveChoicePersistenceResult,
  ProgressionRepository,
} from "../../modules/progression/ports.js";
import {
  applyPokemonXp,
  battlePokemonXp,
  trainerLevelForPoints,
} from "../../modules/progression/rules.js";
import { withTransaction } from "../db/transaction.js";
import { recordPokedexOwned } from "../pokedex/postgres-pokedex-writer.js";

const MAJOR_STATUS_KEYS = ["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"] as const;

class ProgressionStateViolation extends Error {}

function hashParts(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new ProgressionStateViolation(`${label} is outside JS safe range`);
  return parsed;
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

function parseRulesetConfig(config: unknown): RulesetConfig {
  const parsed = RulesetConfigSchema.safeParse(config);
  if (!parsed.success) throw new ProgressionStateViolation("Pinned ruleset config is invalid");
  return parsed.data;
}

interface FormStatsRow extends PokemonBaseStats {
  readonly speciesId: string;
}

async function loadFormStats(
  client: PoolClient,
  contentReleaseId: string,
  formId: string,
): Promise<FormStatsRow> {
  const result = await client.query<{
    species_id: string;
    base_hp: number;
    base_attack: number;
    base_defense: number;
    base_sp_attack: number;
    base_sp_defense: number;
    base_speed: number;
  }>(
    `SELECT form.species_id, revision.base_hp, revision.base_attack, revision.base_defense,
            revision.base_sp_attack, revision.base_sp_defense, revision.base_speed
     FROM pokemon_forms form
     JOIN pokemon_form_revisions revision
       ON revision.form_id = form.id AND revision.content_release_id = $1
     WHERE form.id = $2`,
    [contentReleaseId, formId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new ProgressionStateViolation("Pinned release is missing Pokemon form stats");
  return {
    speciesId: row.species_id,
    hp: row.base_hp,
    attack: row.base_attack,
    defense: row.base_defense,
    spAttack: row.base_sp_attack,
    spDefense: row.base_sp_defense,
    speed: row.base_speed,
  };
}

async function resolveEvolutionAbility(
  client: PoolClient,
  contentReleaseId: string,
  targetFormId: string,
  currentAbilityId: string | null,
): Promise<string> {
  const result = await client.query<{ ability_id: string; slot_kind: string }>(
    `SELECT ability_id, slot_kind
     FROM pokemon_form_ability_options
     WHERE content_release_id = $1 AND form_id = $2 AND active = TRUE
     ORDER BY CASE slot_kind WHEN 'PRIMARY' THEN 1 WHEN 'SECONDARY' THEN 2 ELSE 3 END, ability_id`,
    [contentReleaseId, targetFormId],
  );
  if (currentAbilityId !== null && result.rows.some((row) => row.ability_id === currentAbilityId)) {
    return currentAbilityId;
  }
  const fallback = result.rows[0]?.ability_id;
  if (fallback === undefined) {
    throw new ProgressionStateViolation("Evolution target has no active Ability option");
  }
  return fallback;
}

async function insertPokemonHistory(
  client: PoolClient,
  input: {
    readonly pokemonInstanceId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly actorType: string;
    readonly actorId?: string | null;
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
      input.actorId ?? null,
      input.correlationId,
    ],
  );
}

async function insertOutbox(
  client: PoolClient,
  input: {
    readonly playerId: string;
    readonly messageType: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_messages(
       id, channel, destination_ref, message_type, payload, idempotency_key,
       status, correlation_id, causation_id
     ) VALUES ($1, 'INTERNAL', $2, $3, $4::jsonb, $5, 'PENDING', $6, NULL)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      input.playerId,
      input.messageType,
      JSON.stringify(input.payload),
      input.idempotencyKey,
      input.correlationId,
    ],
  );
}

interface MutableMoveSlot {
  slotNo: number;
  moveId: string;
}

async function learnMovesAtLevel(
  client: PoolClient,
  input: {
    readonly pokemonInstanceId: string;
    readonly playerId: string;
    readonly contentReleaseId: string;
    readonly formId: string;
    readonly level: number;
    readonly sourceId: string;
    readonly correlationId: string;
    readonly slots: MutableMoveSlot[];
    readonly learnedMoveIds: string[];
    readonly pendingMoveChoiceIds: string[];
  },
): Promise<void> {
  const learnset = await client.query<{ move_id: string; max_pp: number | null }>(
    `SELECT entry.move_id, revision.max_pp
     FROM move_learnset_entries entry
     JOIN moves move ON move.id = entry.move_id
     JOIN move_revisions revision
       ON revision.content_release_id = entry.content_release_id
      AND revision.move_id = entry.move_id
     WHERE entry.content_release_id = $1
       AND entry.form_id = $2
       AND entry.learn_method = 'LEVEL'
       AND entry.learn_level = $3
       AND entry.active = TRUE
     ORDER BY move.slug, entry.move_id`,
    [input.contentReleaseId, input.formId, input.level],
  );

  for (const move of learnset.rows) {
    if (input.slots.some((slot) => slot.moveId === move.move_id)) continue;
    const occupied = new Set(input.slots.map((slot) => slot.slotNo));
    let freeSlot: number | null = null;
    for (let slotNo = 1; slotNo <= 4; slotNo += 1) {
      if (!occupied.has(slotNo)) {
        freeSlot = slotNo;
        break;
      }
    }

    if (freeSlot !== null) {
      await client.query(
        `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
         VALUES ($1, $2, $3, $4)`,
        [input.pokemonInstanceId, freeSlot, move.move_id, move.max_pp],
      );
      input.slots.push({ slotNo: freeSlot, moveId: move.move_id });
      input.learnedMoveIds.push(move.move_id);
      await insertPokemonHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "MOVE_LEARNED",
        payload: { moveId: move.move_id, level: input.level, sourceId: input.sourceId },
        actorType: "SYSTEM",
        correlationId: input.correlationId,
      });
      continue;
    }

    const choiceId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO pending_move_choices(
         id, pokemon_instance_id, content_release_id, move_id, learn_level,
         source_type, source_id, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, 'BATTLE_REWARD', $6, $7)
       ON CONFLICT (pokemon_instance_id, content_release_id, move_id, learn_level)
       DO NOTHING
       RETURNING id`,
      [
        choiceId,
        input.pokemonInstanceId,
        input.contentReleaseId,
        move.move_id,
        input.level,
        input.sourceId,
        input.correlationId,
      ],
    );
    let persistedChoiceId = inserted.rows[0]?.id;
    if (persistedChoiceId === undefined) {
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM pending_move_choices
         WHERE pokemon_instance_id = $1 AND content_release_id = $2
           AND move_id = $3 AND learn_level = $4`,
        [input.pokemonInstanceId, input.contentReleaseId, move.move_id, input.level],
      );
      const existingRow = existing.rows[0];
      if (existingRow?.status !== "PENDING") continue;
      persistedChoiceId = existingRow.id;
    }
    input.pendingMoveChoiceIds.push(persistedChoiceId);
    await insertPokemonHistory(client, {
      pokemonInstanceId: input.pokemonInstanceId,
      eventType: "MOVE_CHOICE_PENDING",
      payload: { moveId: move.move_id, level: input.level, choiceId: persistedChoiceId },
      actorType: "SYSTEM",
      correlationId: input.correlationId,
    });
  }
}

interface LevelEvolutionRule {
  readonly id: string;
  readonly toFormId: string;
  readonly triggerLevel: number;
}

async function findLevelEvolution(
  client: PoolClient,
  contentReleaseId: string,
  formId: string,
  level: number,
): Promise<LevelEvolutionRule | null> {
  const result = await client.query<{ id: string; to_form_id: string; trigger_config: unknown }>(
    `SELECT id, to_form_id, trigger_config
     FROM evolution_rules
     WHERE content_release_id = $1 AND from_form_id = $2
       AND trigger_kind = 'LEVEL' AND active = TRUE`,
    [contentReleaseId, formId],
  );
  const eligible: LevelEvolutionRule[] = [];
  for (const row of result.rows) {
    const parsed = EvolutionTriggerSchemas.LEVEL.safeParse(row.trigger_config);
    if (parsed.success && level >= parsed.data.level) {
      eligible.push({ id: row.id, toFormId: row.to_form_id, triggerLevel: parsed.data.level });
    }
  }
  if (eligible.length > 1) {
    throw new ProgressionStateViolation("Multiple level evolutions are eligible for one form");
  }
  return eligible[0] ?? null;
}

async function persistAutoEvolution(
  client: PoolClient,
  input: {
    readonly battleId: string;
    readonly pokemonInstanceId: string;
    readonly playerId: string;
    readonly contentReleaseId: string;
    readonly rulesetId: string;
    readonly rule: LevelEvolutionRule;
    readonly fromFormId: string;
    readonly level: number;
    readonly beforeLevel: number;
    readonly correlationId: string;
  },
): Promise<EvolutionResult> {
  const result = EvolutionResultSchema.parse({
    pokemonInstanceId: input.pokemonInstanceId,
    fromFormId: input.fromFormId,
    toFormId: input.rule.toFormId,
    triggerKind: "LEVEL",
    beforeLevel: input.beforeLevel,
    afterLevel: input.level,
    replayed: false,
  });
  const idempotencyKey = hashParts(
    "progression.auto-evolution",
    input.battleId,
    input.pokemonInstanceId,
    input.rule.id,
  );
  const fingerprint = hashParts(
    input.pokemonInstanceId,
    input.fromFormId,
    input.rule.toFormId,
    String(input.level),
  );
  const inserted = await client.query(
    `INSERT INTO pokemon_evolution_claims(
       id, pokemon_instance_id, content_release_id, ruleset_id, evolution_rule_id,
       from_form_id, to_form_id, trigger_kind, source_type, source_id,
       idempotency_scope, idempotency_key, request_fingerprint, correlation_id, result
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'LEVEL', 'BATTLE_REWARD', $8,
               'progression.auto-evolution', $9, $10, $11, $12::jsonb)
     ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      input.pokemonInstanceId,
      input.contentReleaseId,
      input.rulesetId,
      input.rule.id,
      input.fromFormId,
      input.rule.toFormId,
      input.battleId,
      idempotencyKey,
      fingerprint,
      input.correlationId,
      JSON.stringify(result),
    ],
  );
  if (inserted.rowCount !== 1) {
    throw new ProgressionStateViolation("Auto-evolution claim already exists without reward claim");
  }
  const target = await loadFormStats(client, input.contentReleaseId, input.rule.toFormId);
  await recordPokedexOwned(client, input.playerId, target.speciesId);
  await insertPokemonHistory(client, {
    pokemonInstanceId: input.pokemonInstanceId,
    eventType: "EVOLVED",
    payload: {
      fromFormId: input.fromFormId,
      toFormId: input.rule.toFormId,
      evolutionRuleId: input.rule.id,
      triggerKind: "LEVEL",
      level: input.level,
      battleId: input.battleId,
    },
    actorType: "SYSTEM",
    correlationId: input.correlationId,
  });
  return result;
}

function terminalWinner(state: BattleState): {
  readonly playerId: string;
  readonly winner: BattleCombatant;
  readonly defeated: BattleCombatant;
} | null {
  if (state.sides.length !== 2) return null;
  const playerSide = state.sides.find(
    (side) => side.controllerKind === "PLAYER" && side.result === "WON",
  );
  const defeatedSide = state.sides.find(
    (side) => side.controllerKind !== "PLAYER" && side.result === "LOST",
  );
  if (
    playerSide?.playerId === null ||
    playerSide?.playerId === undefined ||
    defeatedSide === undefined
  ) {
    return null;
  }
  if (playerSide.participantIds.length !== 1 || defeatedSide.participantIds.length !== 1)
    return null;
  const winner = state.combatants.find(
    (combatant) => combatant.participantId === playerSide.activeParticipantId,
  );
  const defeated = state.combatants.find(
    (combatant) => combatant.participantId === defeatedSide.activeParticipantId,
  );
  if (winner === undefined || defeated === undefined || winner.pokemonInstanceId === null)
    return null;
  return { playerId: playerSide.playerId, winner, defeated };
}

export interface ProgressionFaultInjector {
  readonly afterRewardMutationsBeforeClaim?: () => void | Promise<void>;
}

export class PostgresProgressionRepository implements ProgressionRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly faultInjector: ProgressionFaultInjector = {},
  ) {}

  public async applyBattleReward(
    input: ApplyBattleRewardInput,
  ): Promise<BattleRewardPersistenceResult> {
    const storageKey = hashParts("progression.battle-reward", input.idempotencyKey.trim());
    const fingerprint = hashParts("battle", input.battleId);
    try {
      return await withTransaction(this.pool, async (client) => {
        await acquireLocks(client, [
          `progression:battle:${input.battleId}`,
          `progression:reward-key:${storageKey}`,
        ]);

        const claims = await client.query<{
          battle_id: string;
          idempotency_key: string;
          request_fingerprint: string;
          result: unknown;
        }>(
          `SELECT battle_id, idempotency_key, request_fingerprint, result
           FROM battle_reward_claims
           WHERE battle_id = $1 OR idempotency_key = $2`,
          [input.battleId, storageKey],
        );
        if (claims.rows.length > 1) return { kind: "IDEMPOTENCY_CONFLICT" };
        const existingClaim = claims.rows[0];
        if (existingClaim !== undefined) {
          if (existingClaim.battle_id !== input.battleId) return { kind: "IDEMPOTENCY_CONFLICT" };
          if (existingClaim.request_fingerprint !== fingerprint) {
            return { kind: "IDEMPOTENCY_CONFLICT" };
          }
          const parsedResult = BattleRewardResultSchema.parse(existingClaim.result);
          return { kind: "REPLAYED", result: parsedResult };
        }

        const battle = await client.query<{
          battle_type: string;
          status: string;
          content_release_id: string;
          ruleset_id: string;
          version: string;
        }>(
          `SELECT battle_type, status, content_release_id, ruleset_id, version::text
           FROM battles WHERE id = $1 FOR UPDATE`,
          [input.battleId],
        );
        const battleRow = battle.rows[0];
        if (battleRow === undefined) return { kind: "NOT_FOUND" };
        if (battleRow.status !== "WON") return { kind: "NOT_ELIGIBLE", status: battleRow.status };
        if (battleRow.battle_type !== "WILD" && battleRow.battle_type !== "NPC") {
          return { kind: "UNSUPPORTED", reason: "Battle reward v1 does not support PVP" };
        }
        const version = safeInteger(battleRow.version, "battle.version");
        const snapshot = await client.query<{ state: unknown }>(
          `SELECT state FROM battle_state_snapshots WHERE battle_id = $1 AND version = $2`,
          [input.battleId, version],
        );
        const stateRow = snapshot.rows[0];
        if (stateRow === undefined)
          throw new ProgressionStateViolation("Terminal battle snapshot is missing");
        const state = BattleStateSchema.parse(stateRow.state);
        if (
          state.status !== "WON" ||
          state.version !== version ||
          state.contentReleaseId !== battleRow.content_release_id ||
          state.rulesetId !== battleRow.ruleset_id
        ) {
          throw new ProgressionStateViolation("Battle root and terminal snapshot diverged");
        }
        const terminal = terminalWinner(state);
        if (terminal === null) {
          return {
            kind: "UNSUPPORTED",
            reason: "Battle reward v1 requires one-player 1v1 terminal state",
          };
        }

        const ruleset = await client.query<{ config: unknown }>(
          `SELECT config FROM rulesets
           WHERE id = $1 AND status IN ('PUBLISHED', 'ARCHIVED')`,
          [battleRow.ruleset_id],
        );
        const rulesetRow = ruleset.rows[0];
        if (rulesetRow === undefined)
          throw new ProgressionStateViolation("Pinned ruleset is unavailable");
        const config = parseRulesetConfig(rulesetRow.config);
        const progression = config.progression;
        if (progression === undefined) return { kind: "RULES_MISSING" };
        if (config.battle.evEnabled) {
          return {
            kind: "UNSUPPORTED",
            reason:
              "Battle reward v1 refuses EV-enabled stat recalculation until EV support is implemented",
          };
        }

        const species = await client.query<{ base_exp: number | null }>(
          `SELECT base_exp FROM pokemon_species_revisions
           WHERE content_release_id = $1 AND species_id = $2`,
          [battleRow.content_release_id, terminal.defeated.speciesId],
        );
        const baseExp = species.rows[0]?.base_exp;
        if (baseExp === undefined || baseExp === null || baseExp <= 0) {
          throw new ProgressionStateViolation(
            "Defeated species has no valid base EXP in pinned release",
          );
        }
        const offeredXp = battlePokemonXp(baseExp, terminal.defeated.level);
        const pokemonResult = await this.applyPokemonBattleReward(client, {
          battleId: input.battleId,
          playerId: terminal.playerId,
          contentReleaseId: battleRow.content_release_id,
          rulesetId: battleRow.ruleset_id,
          config,
          progression,
          combatant: terminal.winner,
          offeredXp,
          correlationId: input.correlationId,
        });
        const trainerResult = await this.applyTrainerBattleReward(client, {
          battleId: input.battleId,
          playerId: terminal.playerId,
          progression,
          correlationId: input.correlationId,
        });
        await this.faultInjector.afterRewardMutationsBeforeClaim?.();
        const result = BattleRewardResultSchema.parse({
          battleId: input.battleId,
          playerId: terminal.playerId,
          pokemon: [pokemonResult],
          trainer: trainerResult,
          replayed: false,
        });
        const claim = await client.query(
          `INSERT INTO battle_reward_claims(
             battle_id, player_id, idempotency_key, request_fingerprint, result, correlation_id
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT DO NOTHING`,
          [
            input.battleId,
            terminal.playerId,
            storageKey,
            fingerprint,
            JSON.stringify(result),
            input.correlationId,
          ],
        );
        if (claim.rowCount !== 1) {
          throw new ProgressionStateViolation("Battle reward claim raced despite semantic locks");
        }
        await insertOutbox(client, {
          playerId: terminal.playerId,
          messageType: "BATTLE_REWARD_RESULT",
          idempotencyKey: `progression.reward:${input.battleId}`,
          correlationId: input.correlationId,
          payload: result,
        });
        return { kind: "APPLIED", result };
      });
    } catch (error) {
      if (error instanceof ProgressionStateViolation) {
        return { kind: "STATE_INVALID", reason: error.message };
      }
      throw error;
    }
  }

  private async applyPokemonBattleReward(
    client: PoolClient,
    input: {
      readonly battleId: string;
      readonly playerId: string;
      readonly contentReleaseId: string;
      readonly rulesetId: string;
      readonly config: RulesetConfig;
      readonly progression: ProgressionRules;
      readonly combatant: BattleCombatant;
      readonly offeredXp: number;
      readonly correlationId: string;
    },
  ): Promise<PokemonXpAwardResult> {
    const pokemonId = input.combatant.pokemonInstanceId;
    if (pokemonId === null)
      throw new ProgressionStateViolation("Winner lacks Pokemon instance identity");
    const pokemon = await client.query<{
      form_id: string;
      level: number;
      xp: string;
      ability_id: string | null;
      nature_id: string | null;
      iv_hp: number | null;
      iv_attack: number | null;
      iv_defense: number | null;
      iv_sp_attack: number | null;
      iv_sp_defense: number | null;
      iv_speed: number | null;
    }>(
      `SELECT instance.form_id, instance.level, instance.xp::text, instance.ability_id,
              training.nature_id, training.iv_hp, training.iv_attack, training.iv_defense,
              training.iv_sp_attack, training.iv_sp_defense, training.iv_speed
       FROM pokemon_instances instance
       JOIN pokemon_training_values training ON training.pokemon_instance_id = instance.id
       WHERE instance.id = $1 AND instance.owner_player_id = $2 AND instance.status = 'ACTIVE'
       FOR UPDATE OF instance, training`,
      [pokemonId, input.playerId],
    );
    const row = pokemon.rows[0];
    if (row === undefined)
      throw new ProgressionStateViolation("Winning Pokemon is not an active owned instance");
    const beforeXp = safeInteger(row.xp, "pokemon.xp");
    if (
      row.form_id !== input.combatant.formId ||
      row.level !== input.combatant.level ||
      row.ability_id !== input.combatant.ability.abilityId ||
      row.nature_id !== input.combatant.nature.natureId ||
      row.iv_hp !== input.combatant.ivs.hp ||
      row.iv_attack !== input.combatant.ivs.attack ||
      row.iv_defense !== input.combatant.ivs.defense ||
      row.iv_sp_attack !== input.combatant.ivs.spAttack ||
      row.iv_sp_defense !== input.combatant.ivs.spDefense ||
      row.iv_speed !== input.combatant.ivs.speed
    ) {
      throw new ProgressionStateViolation(
        "Winning Pokemon changed after battle snapshot was pinned",
      );
    }

    const persistentMoves = await client.query<{
      slot_no: number;
      move_id: string;
      pp_current: number | null;
    }>(
      `SELECT slot_no, move_id, pp_current
       FROM pokemon_move_slots WHERE pokemon_instance_id = $1 ORDER BY slot_no FOR UPDATE`,
      [pokemonId],
    );
    if (persistentMoves.rows.length !== input.combatant.moves.length) {
      throw new ProgressionStateViolation("Persistent move slots diverged from battle snapshot");
    }
    const slots: MutableMoveSlot[] = [];
    for (const battleMove of input.combatant.moves) {
      const persisted = persistentMoves.rows.find((move) => move.slot_no === battleMove.slotNo);
      if (persisted?.move_id !== battleMove.moveId) {
        throw new ProgressionStateViolation(
          "Persistent move identity diverged from battle snapshot",
        );
      }
      await client.query(
        `UPDATE pokemon_move_slots SET pp_current = $3
         WHERE pokemon_instance_id = $1 AND slot_no = $2`,
        [pokemonId, battleMove.slotNo, battleMove.ppCurrent],
      );
      slots.push({ slotNo: battleMove.slotNo, moveId: battleMove.moveId });
    }

    await client.query(
      `DELETE FROM pokemon_persistent_conditions
       WHERE pokemon_instance_id = $1 AND condition_key = ANY($2::text[])`,
      [pokemonId, MAJOR_STATUS_KEYS],
    );
    if (input.combatant.majorStatus !== null) {
      await client.query(
        `INSERT INTO pokemon_persistent_conditions(
           pokemon_instance_id, condition_key, source_type, source_id, data
         ) VALUES ($1, $2, 'BATTLE', $3, $4::jsonb)`,
        [
          pokemonId,
          input.combatant.majorStatus.key,
          input.battleId,
          JSON.stringify({ counter: input.combatant.majorStatus.counter }),
        ],
      );
    }

    const xp = applyPokemonXp({
      level: row.level,
      xp: beforeXp,
      gain: input.offeredXp,
      levelCap: input.progression.pokemon.levelCap,
    });
    const learnedMoveIds: string[] = [];
    const pendingMoveChoiceIds: string[] = [];
    const evolutions: EvolutionResult[] = [];
    let currentFormId = row.form_id;
    if (row.ability_id === null) {
      throw new ProgressionStateViolation("Winning Pokemon has no persisted Ability");
    }
    let currentAbilityId: string = row.ability_id;
    let previousLevel = row.level;
    const visitedForms = new Set([currentFormId]);

    for (const crossedLevel of xp.crossedLevels) {
      await learnMovesAtLevel(client, {
        pokemonInstanceId: pokemonId,
        playerId: input.playerId,
        contentReleaseId: input.contentReleaseId,
        formId: currentFormId,
        level: crossedLevel,
        sourceId: input.battleId,
        correlationId: input.correlationId,
        slots,
        learnedMoveIds,
        pendingMoveChoiceIds,
      });

      while (input.progression.pokemon.autoLevelEvolution) {
        const rule = await findLevelEvolution(
          client,
          input.contentReleaseId,
          currentFormId,
          crossedLevel,
        );
        if (rule === null) break;
        if (visitedForms.has(rule.toFormId)) {
          throw new ProgressionStateViolation("Evolution rules contain a cycle");
        }
        const evolution = await persistAutoEvolution(client, {
          battleId: input.battleId,
          pokemonInstanceId: pokemonId,
          playerId: input.playerId,
          contentReleaseId: input.contentReleaseId,
          rulesetId: input.rulesetId,
          rule,
          fromFormId: currentFormId,
          level: crossedLevel,
          beforeLevel: previousLevel,
          correlationId: input.correlationId,
        });
        currentAbilityId = await resolveEvolutionAbility(
          client,
          input.contentReleaseId,
          rule.toFormId,
          currentAbilityId,
        );
        currentFormId = rule.toFormId;
        visitedForms.add(currentFormId);
        evolutions.push(evolution);
        await learnMovesAtLevel(client, {
          pokemonInstanceId: pokemonId,
          playerId: input.playerId,
          contentReleaseId: input.contentReleaseId,
          formId: currentFormId,
          level: crossedLevel,
          sourceId: input.battleId,
          correlationId: input.correlationId,
          slots,
          learnedMoveIds,
          pendingMoveChoiceIds,
        });
      }
      previousLevel = crossedLevel;
    }

    const finalForm = await loadFormStats(client, input.contentReleaseId, currentFormId);
    const finalStats = calculatePokemonStats({
      baseStats: finalForm,
      ivs: input.combatant.ivs,
      level: xp.afterLevel,
      nature: input.combatant.nature,
      ivEnabled: input.config.battle.ivEnabled,
      natureEnabled: input.config.battle.natureEnabled,
    });
    const finalHp = adjustCurrentHpAfterStatChange({
      currentHp: input.combatant.currentHp,
      oldMaxHp: input.combatant.maxHp,
      newMaxHp: finalStats.hp,
    });
    const updated = await client.query(
      `UPDATE pokemon_instances
       SET form_id = $3, level = $4, xp = $5, current_hp = $6, ability_id = $7,
           revision = revision + 1, updated_at = now()
       WHERE id = $1 AND owner_player_id = $2 AND form_id = $8 AND level = $9`,
      [
        pokemonId,
        input.playerId,
        currentFormId,
        xp.afterLevel,
        xp.afterXp,
        finalHp,
        currentAbilityId,
        row.form_id,
        row.level,
      ],
    );
    if (updated.rowCount !== 1)
      throw new ProgressionStateViolation("Pokemon progression CAS failed");

    if (xp.awardedXp > 0) {
      const ledger = await client.query(
        `INSERT INTO pokemon_xp_ledger(
           id, pokemon_instance_id, awarded_xp, before_level, after_level, before_xp, after_xp,
           content_release_id, ruleset_id, source_type, source_id, reason, actor_type, actor_id,
           idempotency_scope, idempotency_key, correlation_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                   'BATTLE_REWARD', $10, 'Battle reward XP', 'SYSTEM', NULL,
                   'progression.battle-reward.xp', $11, $12)`,
        [
          randomUUID(),
          pokemonId,
          xp.awardedXp,
          xp.beforeLevel,
          xp.afterLevel,
          xp.beforeXp,
          xp.afterXp,
          input.contentReleaseId,
          input.rulesetId,
          input.battleId,
          hashParts("progression.battle-reward.xp", input.battleId, pokemonId),
          input.correlationId,
        ],
      );
      if (ledger.rowCount !== 1)
        throw new ProgressionStateViolation("Pokemon XP ledger claim failed");
    }
    await insertPokemonHistory(client, {
      pokemonInstanceId: pokemonId,
      eventType: "BATTLE_REWARD_XP",
      payload: {
        battleId: input.battleId,
        offeredXp: input.offeredXp,
        awardedXp: xp.awardedXp,
        discardedXp: xp.discardedXp,
        beforeLevel: xp.beforeLevel,
        afterLevel: xp.afterLevel,
        beforeXp: xp.beforeXp,
        afterXp: xp.afterXp,
        finalHp,
      },
      actorType: "SYSTEM",
      correlationId: input.correlationId,
    });

    return {
      pokemonInstanceId: pokemonId,
      offeredXp: input.offeredXp,
      awardedXp: xp.awardedXp,
      discardedXp: xp.discardedXp,
      beforeLevel: xp.beforeLevel,
      afterLevel: xp.afterLevel,
      beforeXp: xp.beforeXp,
      afterXp: xp.afterXp,
      learnedMoveIds,
      pendingMoveChoiceIds,
      evolutions,
    };
  }

  private async applyTrainerBattleReward(
    client: PoolClient,
    input: {
      readonly battleId: string;
      readonly playerId: string;
      readonly progression: ProgressionRules;
      readonly correlationId: string;
    },
  ): Promise<TrainerProgressResult> {
    await client.query(
      `INSERT INTO trainer_progression(player_id) VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
      [input.playerId],
    );
    const current = await client.query<{ level: number; progression_points: string }>(
      `SELECT level, progression_points::text
       FROM trainer_progression WHERE player_id = $1 FOR UPDATE`,
      [input.playerId],
    );
    const row = current.rows[0];
    if (row === undefined)
      throw new ProgressionStateViolation("Trainer progression row is unavailable");
    const beforePoints = safeInteger(row.progression_points, "trainer progression_points");
    const pointsGained = input.progression.trainer.pointsPerWonBattle;
    const afterPoints = beforePoints + pointsGained;
    if (!Number.isSafeInteger(afterPoints)) {
      throw new ProgressionStateViolation("Trainer progression points overflow JS safe range");
    }
    const afterLevel = trainerLevelForPoints(
      afterPoints,
      input.progression.trainer.levelCap,
      input.progression.trainer.levelCurve,
    );
    const updated = await client.query(
      `UPDATE trainer_progression
       SET progression_points = $2, level = $3, revision = revision + 1, updated_at = now()
       WHERE player_id = $1`,
      [input.playerId, afterPoints, afterLevel],
    );
    if (updated.rowCount !== 1)
      throw new ProgressionStateViolation("Trainer progression update failed");
    await client.query(
      `INSERT INTO trainer_progress_ledger(
         id, player_id, delta, source_type, source_id, reason, actor_type, actor_id,
         idempotency_scope, idempotency_key, correlation_id
       ) VALUES ($1, $2, $3, 'BATTLE_REWARD', $4, 'Won battle progression', 'SYSTEM', NULL,
                 'progression.battle-reward.trainer', $5, $6)`,
      [
        randomUUID(),
        input.playerId,
        pointsGained,
        input.battleId,
        hashParts("progression.battle-reward.trainer", input.battleId, input.playerId),
        input.correlationId,
      ],
    );

    const unlockKeys: string[] = [];
    for (const unlock of input.progression.trainer.unlocks) {
      if (unlock.level > afterLevel) continue;
      const inserted = await client.query(
        `INSERT INTO trainer_unlocks(player_id, unlock_key, source_type, source_id)
         VALUES ($1, $2, 'BATTLE_REWARD', $3)
         ON CONFLICT (player_id, unlock_key) DO NOTHING`,
        [input.playerId, unlock.unlockKey, input.battleId],
      );
      if (inserted.rowCount === 1) unlockKeys.push(unlock.unlockKey);
    }
    return {
      playerId: input.playerId,
      pointsGained,
      beforePoints,
      afterPoints,
      beforeLevel: row.level,
      afterLevel,
      unlockKeys,
    };
  }

  public async resolveMoveChoice(
    input: ResolveMoveChoiceInput,
  ): Promise<MoveChoicePersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [`progression:move-choice:${input.choiceId}`]);
      const choice = await client.query<{
        id: string;
        pokemon_instance_id: string;
        move_id: string;
        content_release_id: string;
        status: string;
        replaced_slot_no: number | null;
      }>(
        `SELECT choice.id, choice.pokemon_instance_id, choice.move_id, choice.content_release_id,
                choice.status, choice.replaced_slot_no
         FROM pending_move_choices choice
         JOIN pokemon_instances pokemon ON pokemon.id = choice.pokemon_instance_id
         WHERE choice.id = $1 AND pokemon.owner_player_id = $2
         FOR UPDATE OF choice, pokemon`,
        [input.choiceId, input.playerId],
      );
      const row = choice.rows[0];
      if (row === undefined) return { kind: "NOT_FOUND" };
      if (row.status !== "PENDING") {
        const compatible =
          (row.status === "SKIPPED" && input.replaceSlotNo === null) ||
          (row.status === "RESOLVED" && row.replaced_slot_no === input.replaceSlotNo);
        if (!compatible)
          return { kind: "CONFLICT", reason: "Move choice was already resolved differently" };
        const replay = MoveChoiceResultSchema.parse({
          choiceId: row.id,
          pokemonInstanceId: row.pokemon_instance_id,
          moveId: row.move_id,
          status: row.status,
          replacedSlotNo: row.replaced_slot_no,
          replayed: true,
        });
        return { kind: "REPLAYED", result: replay };
      }

      if (input.replaceSlotNo === null) {
        await client.query(
          `UPDATE pending_move_choices
           SET status = 'SKIPPED', resolved_at = now()
           WHERE id = $1 AND status = 'PENDING'`,
          [input.choiceId],
        );
        await insertPokemonHistory(client, {
          pokemonInstanceId: row.pokemon_instance_id,
          eventType: "MOVE_LEARN_SKIPPED",
          payload: { choiceId: row.id, moveId: row.move_id },
          actorType: "PLAYER",
          actorId: input.playerId,
          correlationId: input.correlationId,
        });
        const result = MoveChoiceResultSchema.parse({
          choiceId: row.id,
          pokemonInstanceId: row.pokemon_instance_id,
          moveId: row.move_id,
          status: "SKIPPED",
          replacedSlotNo: null,
          replayed: false,
        });
        await insertOutbox(client, {
          playerId: input.playerId,
          messageType: "MOVE_CHOICE_RESULT",
          idempotencyKey: `progression.move-choice:${row.id}`,
          correlationId: input.correlationId,
          payload: result,
        });
        return { kind: "RESOLVED", result };
      }

      const move = await client.query<{ max_pp: number | null }>(
        `SELECT max_pp FROM move_revisions
         WHERE content_release_id = $1 AND move_id = $2`,
        [row.content_release_id, row.move_id],
      );
      if (move.rows[0] === undefined) {
        return { kind: "CONFLICT", reason: "Pinned move revision no longer exists" };
      }
      const replaced = await client.query<{ move_id: string }>(
        `SELECT move_id FROM pokemon_move_slots
         WHERE pokemon_instance_id = $1 AND slot_no = $2 FOR UPDATE`,
        [row.pokemon_instance_id, input.replaceSlotNo],
      );
      const replacedRow = replaced.rows[0];
      if (replacedRow === undefined) {
        return { kind: "CONFLICT", reason: "Replacement slot is no longer occupied" };
      }
      const changed = await client.query(
        `UPDATE pokemon_move_slots
         SET move_id = $3, pp_current = $4, learned_at = now()
         WHERE pokemon_instance_id = $1 AND slot_no = $2`,
        [row.pokemon_instance_id, input.replaceSlotNo, row.move_id, move.rows[0].max_pp],
      );
      if (changed.rowCount !== 1) return { kind: "CONFLICT", reason: "Move replacement failed" };
      await client.query(
        `UPDATE pending_move_choices
         SET status = 'RESOLVED', replaced_slot_no = $2, resolved_at = now()
         WHERE id = $1 AND status = 'PENDING'`,
        [row.id, input.replaceSlotNo],
      );
      await client.query(
        `UPDATE pokemon_instances SET revision = revision + 1, updated_at = now()
         WHERE id = $1 AND owner_player_id = $2`,
        [row.pokemon_instance_id, input.playerId],
      );
      await insertPokemonHistory(client, {
        pokemonInstanceId: row.pokemon_instance_id,
        eventType: "MOVE_REPLACED",
        payload: {
          choiceId: row.id,
          moveId: row.move_id,
          replacedMoveId: replacedRow.move_id,
          slotNo: input.replaceSlotNo,
        },
        actorType: "PLAYER",
        actorId: input.playerId,
        correlationId: input.correlationId,
      });
      const result = MoveChoiceResultSchema.parse({
        choiceId: row.id,
        pokemonInstanceId: row.pokemon_instance_id,
        moveId: row.move_id,
        status: "RESOLVED",
        replacedSlotNo: input.replaceSlotNo,
        replayed: false,
      });
      await insertOutbox(client, {
        playerId: input.playerId,
        messageType: "MOVE_CHOICE_RESULT",
        idempotencyKey: `progression.move-choice:${row.id}`,
        correlationId: input.correlationId,
        payload: result,
      });
      return { kind: "RESOLVED", result };
    });
  }

  public async evolvePokemon(input: EvolvePokemonInput): Promise<EvolutionPersistenceResult> {
    const storageKey = hashParts("progression.evolve", input.idempotencyKey.trim());
    const fingerprint = hashParts(
      input.pokemonInstanceId,
      input.trigger.kind,
      input.trigger.kind === "ITEM"
        ? input.trigger.itemId
        : input.trigger.kind === "CONDITION"
          ? "server-condition"
          : "server-level",
    );
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `progression:evolve-key:${storageKey}`,
        `progression:pokemon:${input.pokemonInstanceId}`,
      ]);
      const existing = await client.query<{
        pokemon_instance_id: string;
        request_fingerprint: string;
        result: unknown;
      }>(
        `SELECT pokemon_instance_id, request_fingerprint, result
         FROM pokemon_evolution_claims
         WHERE idempotency_scope = 'progression.evolve' AND idempotency_key = $1`,
        [storageKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        if (
          existingRow.pokemon_instance_id !== input.pokemonInstanceId ||
          existingRow.request_fingerprint !== fingerprint
        ) {
          return { kind: "IDEMPOTENCY_CONFLICT" };
        }
        const result = EvolutionResultSchema.parse(existingRow.result);
        return { kind: "REPLAYED", result: { ...result, replayed: true } };
      }

      const active = await client.query<{
        content_release_id: string;
        ruleset_id: string;
        ruleset_config: unknown;
      }>(
        `SELECT release.id AS content_release_id, release.default_ruleset_id AS ruleset_id,
                ruleset.config AS ruleset_config
         FROM content_release_pointers pointer
         JOIN content_releases release ON release.id = pointer.content_release_id
         JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
         WHERE pointer.pointer_key = 'ACTIVE'
           AND release.status = 'PUBLISHED'
           AND ruleset.status = 'PUBLISHED'`,
      );
      const activeRow = active.rows[0];
      if (activeRow === undefined) return { kind: "RULES_MISSING" };
      const config = parseRulesetConfig(activeRow.ruleset_config);
      if (config.progression === undefined) return { kind: "RULES_MISSING" };
      if (config.battle.evEnabled) {
        return {
          kind: "NOT_ELIGIBLE",
          reason: "EV-enabled evolution stat recalculation is unsupported",
        };
      }

      const pokemon = await client.query<{
        form_id: string;
        level: number;
        current_hp: number;
        ability_id: string | null;
        nature_id: string | null;
        iv_hp: number | null;
        iv_attack: number | null;
        iv_defense: number | null;
        iv_sp_attack: number | null;
        iv_sp_defense: number | null;
        iv_speed: number | null;
      }>(
        `SELECT instance.form_id, instance.level, instance.current_hp, instance.ability_id,
                training.nature_id, training.iv_hp, training.iv_attack, training.iv_defense,
                training.iv_sp_attack, training.iv_sp_defense, training.iv_speed
         FROM pokemon_instances instance
         JOIN pokemon_training_values training ON training.pokemon_instance_id = instance.id
         WHERE instance.id = $1 AND instance.owner_player_id = $2 AND instance.status = 'ACTIVE'
         FOR UPDATE OF instance, training`,
        [input.pokemonInstanceId, input.playerId],
      );
      const pokemonRow = pokemon.rows[0];
      if (pokemonRow === undefined) return { kind: "NOT_FOUND" };

      const rules = await client.query<{
        id: string;
        to_form_id: string;
        trigger_kind: string;
        trigger_config: unknown;
      }>(
        `SELECT id, to_form_id, trigger_kind, trigger_config
         FROM evolution_rules
         WHERE content_release_id = $1 AND from_form_id = $2
           AND trigger_kind = $3 AND active = TRUE`,
        [activeRow.content_release_id, pokemonRow.form_id, input.trigger.kind],
      );
      let eligible = rules.rows.filter((rule) => {
        if (input.trigger.kind === "LEVEL") {
          const parsed = EvolutionTriggerSchemas.LEVEL.safeParse(rule.trigger_config);
          return parsed.success && pokemonRow.level >= parsed.data.level;
        }
        if (input.trigger.kind === "ITEM") {
          const parsed = EvolutionTriggerSchemas.ITEM.safeParse(rule.trigger_config);
          return parsed.success && parsed.data.itemId === input.trigger.itemId;
        }
        return false;
      });
      if (input.trigger.kind === "CONDITION") {
        const flags = await client.query<{ condition_key: string }>(
          `SELECT condition_key
           FROM pokemon_evolution_condition_flags
           WHERE pokemon_instance_id = $1 AND status = 'ACTIVE'`,
          [input.pokemonInstanceId],
        );
        const activeConditionKeys = new Set(flags.rows.map((entry) => entry.condition_key));
        eligible = rules.rows.filter((rule) => {
          const parsed = EvolutionTriggerSchemas.CONDITION.safeParse(rule.trigger_config);
          return parsed.success && activeConditionKeys.has(parsed.data.conditionKey);
        });
      }
      if (eligible.length === 0)
        return { kind: "NOT_ELIGIBLE", reason: "No evolution rule matches" };
      if (eligible.length > 1) {
        return { kind: "NOT_ELIGIBLE", reason: "Multiple evolution rules match the same request" };
      }
      const rule = eligible[0];
      if (rule === undefined) return { kind: "NOT_ELIGIBLE", reason: "No evolution rule matches" };
      const claimId = randomUUID();

      if (input.trigger.kind === "ITEM") {
        const balance = await client.query(
          `UPDATE inventory_balances
           SET quantity = quantity - 1, revision = revision + 1, updated_at = now()
           WHERE player_id = $1 AND item_id = $2 AND quantity >= 1`,
          [input.playerId, input.trigger.itemId],
        );
        if (balance.rowCount !== 1) return { kind: "ITEM_MISSING" };
        const ledger = await client.query(
          `INSERT INTO inventory_ledger(
             id, player_id, item_id, delta, source_type, source_id, reason,
             actor_type, actor_id, idempotency_scope, idempotency_key, correlation_id
           ) VALUES ($1, $2, $3, -1, 'EVOLUTION', $4, 'Evolution item consumption',
                     'PLAYER', $2, 'progression.evolve.item', $5, $6)
           ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING`,
          [
            randomUUID(),
            input.playerId,
            input.trigger.itemId,
            claimId,
            hashParts("progression.evolve.item", storageKey),
            input.correlationId,
          ],
        );
        if (ledger.rowCount !== 1) {
          throw new ProgressionStateViolation("Evolution item ledger claim failed");
        }
      }

      const oldForm = await loadFormStats(client, activeRow.content_release_id, pokemonRow.form_id);
      const newForm = await loadFormStats(client, activeRow.content_release_id, rule.to_form_id);
      const nature = await this.loadNature(client, {
        contentReleaseId: activeRow.content_release_id,
        natureId: pokemonRow.nature_id,
      });
      const ivs = this.requireIvs(pokemonRow);
      const oldStats = calculatePokemonStats({
        baseStats: oldForm,
        ivs,
        level: pokemonRow.level,
        nature,
        ivEnabled: config.battle.ivEnabled,
        natureEnabled: config.battle.natureEnabled,
      });
      const newStats = calculatePokemonStats({
        baseStats: newForm,
        ivs,
        level: pokemonRow.level,
        nature,
        ivEnabled: config.battle.ivEnabled,
        natureEnabled: config.battle.natureEnabled,
      });
      const currentHp = adjustCurrentHpAfterStatChange({
        currentHp: pokemonRow.current_hp,
        oldMaxHp: oldStats.hp,
        newMaxHp: newStats.hp,
      });
      const abilityId = await resolveEvolutionAbility(
        client,
        activeRow.content_release_id,
        rule.to_form_id,
        pokemonRow.ability_id,
      );
      const changed = await client.query(
        `UPDATE pokemon_instances
         SET form_id = $3, current_hp = $4, ability_id = $5,
             revision = revision + 1, updated_at = now()
         WHERE id = $1 AND owner_player_id = $2 AND form_id = $6`,
        [
          input.pokemonInstanceId,
          input.playerId,
          rule.to_form_id,
          currentHp,
          abilityId,
          pokemonRow.form_id,
        ],
      );
      if (changed.rowCount !== 1) {
        throw new ProgressionStateViolation("Evolution Pokemon CAS failed");
      }
      await recordPokedexOwned(client, input.playerId, newForm.speciesId);
      const result = EvolutionResultSchema.parse({
        pokemonInstanceId: input.pokemonInstanceId,
        fromFormId: pokemonRow.form_id,
        toFormId: rule.to_form_id,
        triggerKind: input.trigger.kind,
        beforeLevel: pokemonRow.level,
        afterLevel: pokemonRow.level,
        replayed: false,
      });
      const claim = await client.query(
        `INSERT INTO pokemon_evolution_claims(
           id, pokemon_instance_id, content_release_id, ruleset_id, evolution_rule_id,
           from_form_id, to_form_id, trigger_kind, source_type, source_id,
           idempotency_scope, idempotency_key, request_fingerprint, correlation_id, result
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PLAYER_ACTION', $13,
                   'progression.evolve', $9, $10, $11, $12::jsonb)`,
        [
          claimId,
          input.pokemonInstanceId,
          activeRow.content_release_id,
          activeRow.ruleset_id,
          rule.id,
          pokemonRow.form_id,
          rule.to_form_id,
          input.trigger.kind,
          storageKey,
          fingerprint,
          input.correlationId,
          JSON.stringify(result),
          input.pokemonInstanceId,
        ],
      );
      if (claim.rowCount !== 1)
        throw new ProgressionStateViolation("Evolution claim insert failed");
      await insertPokemonHistory(client, {
        pokemonInstanceId: input.pokemonInstanceId,
        eventType: "EVOLVED",
        payload: {
          fromFormId: pokemonRow.form_id,
          toFormId: rule.to_form_id,
          evolutionRuleId: rule.id,
          triggerKind: input.trigger.kind,
        },
        actorType: "PLAYER",
        actorId: input.playerId,
        correlationId: input.correlationId,
      });
      await insertOutbox(client, {
        playerId: input.playerId,
        messageType: "EVOLUTION_RESULT",
        idempotencyKey: `progression.evolution:${claimId}`,
        correlationId: input.correlationId,
        payload: result,
      });
      return { kind: "EVOLVED", result };
    });
  }

  private async loadNature(
    client: PoolClient,
    input: { readonly contentReleaseId: string; readonly natureId: string | null },
  ): Promise<{
    readonly increasedStat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
    readonly decreasedStat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  }> {
    if (input.natureId === null) return { increasedStat: null, decreasedStat: null };
    const result = await client.query<{
      increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
      decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
    }>(
      `SELECT increased_stat, decreased_stat FROM nature_revisions
       WHERE content_release_id = $1 AND nature_id = $2`,
      [input.contentReleaseId, input.natureId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new ProgressionStateViolation("Pinned nature revision is unavailable");
    return { increasedStat: row.increased_stat, decreasedStat: row.decreased_stat };
  }

  private requireIvs(row: {
    readonly iv_hp: number | null;
    readonly iv_attack: number | null;
    readonly iv_defense: number | null;
    readonly iv_sp_attack: number | null;
    readonly iv_sp_defense: number | null;
    readonly iv_speed: number | null;
  }): {
    readonly hp: number;
    readonly attack: number;
    readonly defense: number;
    readonly spAttack: number;
    readonly spDefense: number;
    readonly speed: number;
  } {
    const values = [
      row.iv_hp,
      row.iv_attack,
      row.iv_defense,
      row.iv_sp_attack,
      row.iv_sp_defense,
      row.iv_speed,
    ];
    if (values.some((value) => value === null)) {
      throw new ProgressionStateViolation("Pokemon IV data is incomplete");
    }
    return {
      hp: row.iv_hp ?? 0,
      attack: row.iv_attack ?? 0,
      defense: row.iv_defense ?? 0,
      spAttack: row.iv_sp_attack ?? 0,
      spDefense: row.iv_sp_defense ?? 0,
      speed: row.iv_speed ?? 0,
    };
  }
}
