import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  BattleActionSchema,
  BattleStateSchema,
  BattleStatusSchema,
  type BattleAction,
  type BattleState,
} from "../../modules/battle/contracts.js";
import type {
  BattleInitializationData,
  BattlePokemonBuild,
  BattleRepository,
  BattleRootRecord,
  BattleTransaction,
  PersistTurnInput,
  PersistTurnResult,
  StoredBattleAction,
} from "../../modules/battle/ports.js";
import {
  ContentLifecycleStatusSchema,
  type RulesetSnapshot,
} from "../../modules/catalog/contracts.js";
import type { WildPokemonSnapshot } from "../../modules/encounter/contracts.js";
import { withTransaction } from "../db/transaction.js";

interface RootRow {
  readonly id: string;
  readonly battle_type: "WILD" | "NPC" | "PVP";
  readonly status: string;
  readonly content_release_id: string;
  readonly ruleset_id: string;
  readonly encounter_id: string | null;
  readonly turn_number: number;
  readonly version: string;
  readonly rng_seed_ciphertext: Buffer;
  readonly rng_seed_iv: Buffer;
  readonly rng_seed_auth_tag: Buffer;
  readonly rng_seed_key_version: number;
  readonly rng_counter: string;
  readonly ended_at: Date | null;
}

interface PokemonRow {
  readonly pokemon_instance_id: string;
  readonly roster_position: number;
  readonly form_id: string;
  readonly species_id: string;
  readonly level: number;
  readonly current_hp: number;
  readonly type1_id: string;
  readonly type1_slug: string;
  readonly type2_id: string | null;
  readonly type2_slug: string | null;
  readonly base_hp: number;
  readonly base_attack: number;
  readonly base_defense: number;
  readonly base_sp_attack: number;
  readonly base_sp_defense: number;
  readonly base_speed: number;
  readonly iv_hp: number | null;
  readonly iv_attack: number | null;
  readonly iv_defense: number | null;
  readonly iv_sp_attack: number | null;
  readonly iv_sp_defense: number | null;
  readonly iv_speed: number | null;
  readonly nature_id: string | null;
  readonly increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  readonly decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  readonly ability_id: string | null;
  readonly ability_effect_key: string | null;
  readonly ability_effect_config: unknown;
}

interface MoveRow {
  readonly slot_no: number;
  readonly move_id: string;
  readonly type_id: string;
  readonly type_slug: string;
  readonly category: "PHYSICAL" | "SPECIAL" | "STATUS";
  readonly power: number | null;
  readonly accuracy: number | null;
  readonly priority: number;
  readonly max_pp: number | null;
  readonly pp_current: number | null;
  readonly effect_key: string | null;
  readonly effect_config: unknown;
  readonly flags: unknown;
}

function safeVersion(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${label} is outside JS safe range`);
  return parsed;
}

function parseRoot(row: RootRow): BattleRootRecord {
  return {
    battleId: row.id,
    battleType: row.battle_type,
    status: BattleStatusSchema.parse(row.status),
    contentReleaseId: row.content_release_id,
    rulesetId: row.ruleset_id,
    encounterId: row.encounter_id,
    turnNumber: row.turn_number,
    version: safeVersion(row.version, "battle.version"),
    seed: {
      ciphertext: row.rng_seed_ciphertext,
      iv: row.rng_seed_iv,
      authTag: row.rng_seed_auth_tag,
      keyVersion: row.rng_seed_key_version,
    },
    rngCounter: BigInt(row.rng_counter),
    endedAt: row.ended_at,
  };
}

function maxHp(baseHp: number, ivHp: number, level: number): number {
  return Math.floor(((2 * baseHp + ivHp) * level) / 100) + level + 10;
}

function moveContact(flags: unknown): boolean {
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) return false;
  const value = flags as Record<string, unknown>;
  return value.schemaVersion === 1 && value.makesContact === true;
}

function majorStatus(value: string | undefined): BattlePokemonBuild["majorStatus"] {
  if (
    value === "BURN" ||
    value === "POISON" ||
    value === "PARALYSIS" ||
    value === "SLEEP" ||
    value === "FREEZE"
  ) {
    return value;
  }
  return null;
}

class PostgresBattleTransaction implements BattleTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async loadRoot(battleId: string, lock = false): Promise<BattleRootRecord | null> {
    const result = await this.client.query<RootRow>(
      `SELECT id, battle_type, status, content_release_id, ruleset_id, encounter_id,
              turn_number, version::text, rng_seed_ciphertext, rng_seed_iv,
              rng_seed_auth_tag, rng_seed_key_version, rng_counter::text, ended_at
       FROM battles
       WHERE id = $1
       ${lock ? "FOR UPDATE" : ""}`,
      [battleId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseRoot(row);
  }

  public async loadRuleset(rulesetId: string): Promise<RulesetSnapshot | null> {
    const root = await this.client.query<{ id: string; status: string; config: unknown }>(
      `SELECT id, status, config FROM rulesets WHERE id = $1`,
      [rulesetId],
    );
    const row = root.rows[0];
    if (row === undefined) return null;
    const matchups = await this.client.query<{
      attacking_type_id: string;
      defending_type_id: string;
      multiplier_basis_points: number;
    }>(
      `SELECT attacking_type_id, defending_type_id, multiplier_basis_points
       FROM type_matchups
       WHERE ruleset_id = $1
       ORDER BY attacking_type_id, defending_type_id`,
      [rulesetId],
    );
    return {
      id: row.id,
      status: ContentLifecycleStatusSchema.parse(row.status),
      config: row.config,
      typeMatchups: matchups.rows.map((entry) => ({
        attackingTypeId: entry.attacking_type_id,
        defendingTypeId: entry.defending_type_id,
        multiplierBasisPoints: entry.multiplier_basis_points,
      })),
    };
  }

  public async loadState(battleId: string, version?: number): Promise<BattleState | null> {
    const result =
      version === undefined
        ? await this.client.query<{ state: unknown }>(
            `SELECT state FROM battle_state_snapshots
             WHERE battle_id = $1 ORDER BY version DESC LIMIT 1`,
            [battleId],
          )
        : await this.client.query<{ state: unknown }>(
            `SELECT state FROM battle_state_snapshots WHERE battle_id = $1 AND version = $2`,
            [battleId, version],
          );
    const row = result.rows[0];
    return row === undefined ? null : BattleStateSchema.parse(row.state);
  }

  private async movesForPokemon(
    releaseId: string,
    pokemonInstanceId: string,
  ): Promise<readonly MoveRow[]> {
    const result = await this.client.query<MoveRow>(
      `SELECT pms.slot_no, pms.move_id, mr.type_id, pt.slug AS type_slug,
              mr.category, mr.power, mr.accuracy, mr.priority, mr.max_pp,
              pms.pp_current, mr.effect_key, mr.effect_config, mr.flags
       FROM pokemon_move_slots pms
       JOIN move_revisions mr
         ON mr.move_id = pms.move_id AND mr.content_release_id = $1
       JOIN pokemon_types pt ON pt.id = mr.type_id
       WHERE pms.pokemon_instance_id = $2
       ORDER BY pms.slot_no`,
      [releaseId, pokemonInstanceId],
    );
    return result.rows;
  }

  private async enrichPlayerPokemon(
    releaseId: string,
    row: PokemonRow,
  ): Promise<BattlePokemonBuild> {
    if (row.nature_id === null || row.ability_id === null) {
      throw new Error("Battle player Pokemon is missing Nature or Ability");
    }
    const moves = await this.movesForPokemon(releaseId, row.pokemon_instance_id);
    if (moves.length === 0 || moves.length > 4) {
      throw new Error("Battle player Pokemon must have 1..4 move slots");
    }
    const conditions = await this.client.query<{ condition_key: string }>(
      `SELECT condition_key
       FROM pokemon_persistent_conditions
       WHERE pokemon_instance_id = $1
         AND condition_key IN ('BURN','POISON','PARALYSIS','SLEEP','FREEZE')
       ORDER BY condition_key`,
      [row.pokemon_instance_id],
    );
    if (conditions.rowCount !== null && conditions.rowCount > 1) {
      throw new Error("Pokemon has more than one persistent major battle condition");
    }
    const ivs = {
      hp: row.iv_hp ?? 0,
      attack: row.iv_attack ?? 0,
      defense: row.iv_defense ?? 0,
      spAttack: row.iv_sp_attack ?? 0,
      spDefense: row.iv_sp_defense ?? 0,
      speed: row.iv_speed ?? 0,
    };
    const hp = maxHp(row.base_hp, ivs.hp, row.level);
    return {
      pokemonInstanceId: row.pokemon_instance_id,
      participantKind: "PLAYER_POKEMON",
      rosterPosition: row.roster_position,
      formId: row.form_id,
      speciesId: row.species_id,
      level: row.level,
      type1Id: row.type1_id,
      type1Slug: row.type1_slug,
      type2Id: row.type2_id,
      type2Slug: row.type2_slug,
      baseStats: {
        hp: row.base_hp,
        attack: row.base_attack,
        defense: row.base_defense,
        spAttack: row.base_sp_attack,
        spDefense: row.base_sp_defense,
        speed: row.base_speed,
      },
      ivs,
      nature: {
        natureId: row.nature_id,
        increasedStat: row.increased_stat,
        decreasedStat: row.decreased_stat,
      },
      ability: {
        abilityId: row.ability_id,
        effectKey: row.ability_effect_key,
        effectConfig: row.ability_effect_config,
      },
      moves: moves.map((move) => ({
        slotNo: move.slot_no,
        moveId: move.move_id,
        typeId: move.type_id,
        typeSlug: move.type_slug,
        category: move.category,
        power: move.power,
        accuracy: move.accuracy,
        priority: move.priority,
        maxPp: move.max_pp,
        ppCurrent: move.pp_current,
        effectKey: move.effect_key,
        effectConfig: move.effect_config,
        makesContact: moveContact(move.flags),
      })),
      maxHp: hp,
      currentHp: Math.min(row.current_hp, hp),
      majorStatus: majorStatus(conditions.rows[0]?.condition_key),
    };
  }

  private async enrichWildPokemon(
    releaseId: string,
    snapshot: WildPokemonSnapshot,
  ): Promise<BattlePokemonBuild> {
    const content = await this.client.query<{
      type1_slug: string;
      type2_slug: string | null;
      increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
      decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
      ability_effect_key: string | null;
      ability_effect_config: unknown;
    }>(
      `SELECT t1.slug AS type1_slug, t2.slug AS type2_slug,
              nr.increased_stat, nr.decreased_stat,
              ar.effect_key AS ability_effect_key, ar.effect_config AS ability_effect_config
       FROM pokemon_form_revisions pfr
       JOIN pokemon_types t1 ON t1.id = pfr.type1_id
       LEFT JOIN pokemon_types t2 ON t2.id = pfr.type2_id
       JOIN nature_revisions nr
         ON nr.content_release_id = pfr.content_release_id AND nr.nature_id = $3
       JOIN ability_revisions ar
         ON ar.content_release_id = pfr.content_release_id AND ar.ability_id = $4
       WHERE pfr.content_release_id = $1 AND pfr.form_id = $2`,
      [releaseId, snapshot.formId, snapshot.natureId, snapshot.abilityId],
    );
    const row = content.rows[0];
    if (row === undefined) throw new Error("Pinned wild Pokemon content is incomplete");
    const moveIds = snapshot.moves.map((move) => move.moveId);
    const moves = await this.client.query<MoveRow>(
      `SELECT 0::integer AS slot_no, mr.move_id, mr.type_id, pt.slug AS type_slug,
              mr.category, mr.power, mr.accuracy, mr.priority, mr.max_pp,
              NULL::smallint AS pp_current, mr.effect_key, mr.effect_config, mr.flags
       FROM move_revisions mr
       JOIN pokemon_types pt ON pt.id = mr.type_id
       WHERE mr.content_release_id = $1 AND mr.move_id = ANY($2::uuid[])`,
      [releaseId, moveIds],
    );
    const byMove = new Map(moves.rows.map((move) => [move.move_id, move]));
    return {
      pokemonInstanceId: null,
      participantKind: "WILD_POKEMON",
      rosterPosition: 1,
      formId: snapshot.formId,
      speciesId: snapshot.speciesId,
      level: snapshot.level,
      type1Id: snapshot.type1Id,
      type1Slug: row.type1_slug,
      type2Id: snapshot.type2Id,
      type2Slug: row.type2_slug,
      baseStats: { ...snapshot.baseStats },
      ivs: { ...snapshot.ivs },
      nature: {
        natureId: snapshot.natureId,
        increasedStat: row.increased_stat,
        decreasedStat: row.decreased_stat,
      },
      ability: {
        abilityId: snapshot.abilityId,
        effectKey: row.ability_effect_key,
        effectConfig: row.ability_effect_config,
      },
      moves: snapshot.moves.map((source, index) => {
        const move = byMove.get(source.moveId);
        if (move === undefined) throw new Error("Pinned wild move content is missing");
        return {
          slotNo: index + 1,
          moveId: move.move_id,
          typeId: move.type_id,
          typeSlug: move.type_slug,
          category: move.category,
          power: move.power,
          accuracy: move.accuracy,
          priority: move.priority,
          maxPp: move.max_pp,
          ppCurrent: source.ppCurrent,
          effectKey: move.effect_key,
          effectConfig: move.effect_config,
          makesContact: moveContact(move.flags),
        };
      }),
      maxHp: snapshot.maxHp,
      currentHp: snapshot.currentHp,
      majorStatus: null,
    };
  }

  public async loadInitializationData(
    root: BattleRootRecord,
  ): Promise<BattleInitializationData | null> {
    if (root.battleType !== "WILD" || root.encounterId === null) return null;
    const encounter = await this.client.query<{ player_id: string; pokemon_snapshot: unknown }>(
      `SELECT e.player_id, es.pokemon_snapshot
       FROM encounters e
       JOIN encounter_snapshots es ON es.encounter_id = e.id
       WHERE e.id = $1 AND e.content_release_id = $2 AND e.ruleset_id = $3`,
      [root.encounterId, root.contentReleaseId, root.rulesetId],
    );
    const encounterRow = encounter.rows[0];
    if (encounterRow === undefined) return null;
    const wild = encounterRow.pokemon_snapshot as WildPokemonSnapshot;
    if (wild.schemaVersion !== 1) throw new Error("Unsupported wild encounter snapshot version");

    const party = await this.client.query<PokemonRow>(
      `SELECT pi.id AS pokemon_instance_id, prs.slot_no AS roster_position,
              pi.form_id, pf.species_id, pi.level, pi.current_hp,
              pfr.type1_id, t1.slug AS type1_slug, pfr.type2_id, t2.slug AS type2_slug,
              pfr.base_hp, pfr.base_attack, pfr.base_defense, pfr.base_sp_attack,
              pfr.base_sp_defense, pfr.base_speed,
              ptv.iv_hp, ptv.iv_attack, ptv.iv_defense, ptv.iv_sp_attack,
              ptv.iv_sp_defense, ptv.iv_speed, ptv.nature_id,
              nr.increased_stat, nr.decreased_stat,
              pi.ability_id, ar.effect_key AS ability_effect_key,
              ar.effect_config AS ability_effect_config
       FROM pokemon_roster_slots prs
       JOIN pokemon_instances pi
         ON pi.id = prs.pokemon_instance_id AND pi.owner_player_id = prs.player_id
       JOIN pokemon_forms pf ON pf.id = pi.form_id
       JOIN pokemon_form_revisions pfr
         ON pfr.form_id = pi.form_id AND pfr.content_release_id = $2
       JOIN pokemon_types t1 ON t1.id = pfr.type1_id
       LEFT JOIN pokemon_types t2 ON t2.id = pfr.type2_id
       LEFT JOIN pokemon_training_values ptv ON ptv.pokemon_instance_id = pi.id
       LEFT JOIN nature_revisions nr
         ON nr.nature_id = ptv.nature_id AND nr.content_release_id = $2
       LEFT JOIN ability_revisions ar
         ON ar.ability_id = pi.ability_id AND ar.content_release_id = $2
       WHERE prs.player_id = $1
         AND prs.placement_kind = 'TEAM'
         AND pi.status = 'ACTIVE'
       ORDER BY prs.slot_no`,
      [encounterRow.player_id, root.contentReleaseId],
    );
    if (party.rows.length === 0) return null;
    const playerParty: BattlePokemonBuild[] = [];
    for (const row of party.rows) {
      playerParty.push(await this.enrichPlayerPokemon(root.contentReleaseId, row));
    }
    return {
      playerId: encounterRow.player_id,
      playerParty,
      opponentParty: [await this.enrichWildPokemon(root.contentReleaseId, wild)],
    };
  }

  public async initialize(root: BattleRootRecord, state: BattleState): Promise<BattleState> {
    const existing = await this.loadState(root.battleId, 0);
    if (existing !== null) return existing;
    if (root.version !== 0 || root.status !== "CREATED") {
      throw new Error("Battle root is not eligible for snapshot-v0 initialization");
    }

    const sideIdByNo = new Map<number, string>();
    for (const side of state.sides) {
      const sideId = randomUUID();
      sideIdByNo.set(side.sideNo, sideId);
      await this.client.query(
        `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id, result)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sideId, state.battleId, side.sideNo, side.controllerKind, side.playerId, side.result],
      );
    }
    for (const combatant of state.combatants) {
      const sideId = sideIdByNo.get(combatant.sideNo);
      if (sideId === undefined) throw new Error("Battle side mapping is incomplete");
      await this.client.query(
        `INSERT INTO battle_participants(
           id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
           roster_position, active_member, snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7::jsonb)`,
        [
          combatant.participantId,
          state.battleId,
          sideId,
          combatant.pokemonInstanceId,
          combatant.participantKind,
          combatant.rosterPosition,
          JSON.stringify(combatant),
        ],
      );
    }
    await this.client.query(
      `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
       VALUES ($1, 0, 1, $2::jsonb)`,
      [state.battleId, JSON.stringify(state)],
    );
    const updated = await this.client.query(
      `UPDATE battles
       SET status = 'ACTIVE', updated_at = now()
       WHERE id = $1 AND status = 'CREATED' AND version = 0`,
      [state.battleId],
    );
    if (updated.rowCount !== 1) throw new Error("Battle initialization CAS failed");
    return state;
  }

  public async findAction(
    idempotencyKey: string,
    lock = false,
  ): Promise<StoredBattleAction | null> {
    const result = await this.client.query<{
      id: string;
      battle_id: string;
      payload: unknown;
      expected_battle_version: string;
      idempotency_key: string;
      status: "RECEIVED" | "ACCEPTED" | "REJECTED" | "RESOLVED";
      correlation_id: string;
      resolved_battle_version: string | null;
    }>(
      `SELECT id, battle_id, payload, expected_battle_version::text, idempotency_key,
              status, correlation_id, resolved_battle_version::text
       FROM battle_actions
       WHERE idempotency_key = $1
       ${lock ? "FOR UPDATE" : ""}`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      actionId: row.id,
      battleId: row.battle_id,
      expectedBattleVersion: safeVersion(row.expected_battle_version, "expected battle version"),
      idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id,
      action: BattleActionSchema.parse(row.payload),
      status: row.status,
      resolvedBattleVersion:
        row.resolved_battle_version === null
          ? null
          : safeVersion(row.resolved_battle_version, "resolved battle version"),
    };
  }

  public async rejectAction(input: {
    readonly actionId: string;
    readonly battleId: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly action: BattleAction;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO battle_actions(
         id, battle_id, actor_participant_id, action_type, payload,
         expected_battle_version, idempotency_key, status, resolved_at, correlation_id
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'REJECTED', now(), $8)`,
      [
        input.actionId,
        input.battleId,
        input.action.actorParticipantId,
        input.action.type,
        JSON.stringify(input.action),
        input.expectedVersion,
        input.idempotencyKey,
        input.correlationId,
      ],
    );
  }

  public async persistTurn(input: PersistTurnInput): Promise<PersistTurnResult> {
    const terminal = ["WON", "LOST", "FLED", "DRAW", "CANCELLED"].includes(input.nextState.status);
    const updated = await this.client.query(
      `UPDATE battles
       SET status = $3,
           turn_number = $4,
           version = $5,
           rng_counter = $6,
           updated_at = now(),
           ended_at = CASE WHEN $7::boolean THEN now() ELSE NULL END
       WHERE id = $1 AND version = $2 AND status = 'ACTIVE'`,
      [
        input.battleId,
        input.expectedVersion,
        input.nextState.status,
        input.nextState.turnNumber,
        input.nextState.version,
        input.rngCounter.toString(),
        terminal,
      ],
    );
    if (updated.rowCount !== 1) {
      const currentRoot = await this.loadRoot(input.battleId);
      if (currentRoot === null) throw new Error("Battle disappeared during CAS conflict");
      const currentState = await this.loadState(input.battleId, currentRoot.version);
      if (currentState === null) throw new Error("Battle CAS conflict has no current snapshot");
      return { kind: "VERSION_CONFLICT", currentState };
    }

    await this.client.query(
      `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
       VALUES ($1, $2, 1, $3::jsonb)`,
      [input.battleId, input.nextState.version, JSON.stringify(input.nextState)],
    );
    await this.client.query(
      `INSERT INTO battle_actions(
         id, battle_id, actor_participant_id, action_type, payload,
         expected_battle_version, idempotency_key, status, resolved_at,
         correlation_id, resolved_battle_version
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'RESOLVED', now(), $8, $9)`,
      [
        input.actionId,
        input.battleId,
        input.playerAction.actorParticipantId,
        input.playerAction.type,
        JSON.stringify(input.playerAction),
        input.expectedVersion,
        input.idempotencyKey,
        input.correlationId,
        input.nextState.version,
      ],
    );

    const seq = await this.client.query<{ next_seq: string }>(
      `SELECT (COALESCE(MAX(seq), 0) + 1)::text AS next_seq
       FROM battle_events WHERE battle_id = $1`,
      [input.battleId],
    );
    let nextSeq = BigInt(seq.rows[0]?.next_seq ?? "1");
    for (const entry of input.events) {
      await this.client.query(
        `INSERT INTO battle_events(
           id, battle_id, seq, battle_version, event_type, payload,
           causation_id, correlation_id
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          randomUUID(),
          input.battleId,
          nextSeq.toString(),
          input.nextState.version,
          entry.type,
          JSON.stringify(entry.payload),
          input.actionId,
          input.correlationId,
        ],
      );
      nextSeq += 1n;
    }

    for (const side of input.nextState.sides) {
      if (side.result === null) continue;
      await this.client.query(
        `UPDATE battle_sides SET result = $3 WHERE battle_id = $1 AND side_no = $2`,
        [input.battleId, side.sideNo, side.result],
      );
    }
    return { kind: "PERSISTED", state: input.nextState };
  }
}

export class PostgresBattleRepository implements BattleRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (transaction: BattleTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresBattleTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (transaction: BattleTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresBattleTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
