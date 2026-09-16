import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { type BattleState, BattleStateSchema } from "../../modules/battle/contracts.js";
import {
  type CaptureAttemptRecord,
  CaptureAttemptStatusSchema,
  type CaptureContext,
  type CaptureProbabilityBreakdown,
  type CaptureRosterPlacement,
  CaptureSourceStatusSchema,
} from "../../modules/capture/contracts.js";
import type {
  CaptureBallConsumeResult,
  CaptureFailureWrite,
  CapturePendingWrite,
  CaptureRepository,
  CaptureSuccessWrite,
  CaptureTransaction,
} from "../../modules/capture/ports.js";
import { WildPokemonSnapshotSchema } from "../../modules/encounter/snapshot-schema.js";
import {
  type EncounterId,
  type PlayerId,
  type PokemonInstanceId,
  parseEncounterId,
  parsePlayerId,
  parsePokemonInstanceId,
} from "../../shared-kernel/ids.js";
import { openControllerTurnWindowInTransaction } from "../battle/postgres-battle-turn-window-repository.js";
import { withTransaction } from "../db/transaction.js";
import { nextCanonicalRosterPlacement } from "../player/postgres-roster-placement.js";
import { recordPokedexCaught } from "../pokedex/postgres-pokedex-writer.js";

const breakdownSchema = z
  .object({
    model: z.literal("POKEMON_INSPIRED_V1"),
    catchRate: z.number().int().min(0).max(255),
    catchRateBasisPoints: z.number().int().min(0).max(10_000),
    currentHp: z.number().int().positive(),
    maxHp: z.number().int().positive(),
    hpFactorBasisPoints: z.number().int().min(0).max(10_000),
    ballMultiplierBasisPoints: z.number().int().min(1).max(100_000),
    status: z.enum(["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"]).nullable(),
    statusMultiplierBasisPoints: z.number().int().min(1).max(100_000),
    explicitModifierBasisPoints: z.array(z.number().int().min(1).max(100_000)).max(16),
    rawProbabilityBasisPoints: z.number().int().min(0).max(10_000),
    maxProbabilityBasisPoints: z.number().int().min(1).max(10_000),
    finalProbabilityBasisPoints: z.number().int().min(0).max(10_000),
  })
  .strict();

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function encounterId(value: string): EncounterId {
  const parsed = parseEncounterId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid EncounterId");
  return parsed.value;
}

function pokemonId(value: string): PokemonInstanceId {
  const parsed = parsePokemonInstanceId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PokemonInstanceId");
  return parsed.value;
}

function safeVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("battle.version is outside JS safe range");
  return parsed;
}

function cancelledState(source: BattleState): BattleState {
  const state = structuredClone(source);
  state.status = "CANCELLED";
  state.version += 1;
  for (const side of state.sides) side.result = "CANCELLED";
  return BattleStateSchema.parse(state);
}

class PostgresCaptureTransaction implements CaptureTransaction {
  public constructor(
    private readonly client: PoolClient,
    private readonly turnWindowTtlMs?: number,
  ) {}

  public async findAttempt(idempotencyStorageKey: string): Promise<CaptureAttemptRecord | null> {
    const result = await this.client.query<{
      id: string;
      player_id: string;
      encounter_id: string;
      battle_id: string | null;
      ball_item_id: string;
      target_wild_no: number;
      idempotency_key: string;
      request_fingerprint: string;
      source_encounter_status: string;
      correlation_id: string;
      status: string;
      probability_basis_points: number;
      roll_basis_points: number;
      pokemon_instance_id: string | null;
      resolved_at: Date | null;
      breakdown: unknown;
      placement_kind: "TEAM" | "BOX" | null;
      box_no: number | null;
      slot_no: number | null;
    }>(
      `SELECT attempt.id, attempt.player_id, attempt.encounter_id, attempt.battle_id,
              attempt.ball_item_id, attempt.target_wild_no, attempt.idempotency_key,
              attempt.request_fingerprint,
              attempt.source_encounter_status, attempt.correlation_id, attempt.status,
              attempt.probability_basis_points, attempt.roll_basis_points,
              attempt.pokemon_instance_id, attempt.resolved_at, attempt.breakdown,
              roster.placement_kind, roster.box_no, roster.slot_no
       FROM capture_attempts attempt
       LEFT JOIN pokemon_roster_slots roster
         ON roster.pokemon_instance_id = attempt.pokemon_instance_id
       WHERE attempt.idempotency_key = $1`,
      [idempotencyStorageKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const status = CaptureAttemptStatusSchema.parse(row.status);
    const source = CaptureSourceStatusSchema.parse(row.source_encounter_status);
    const breakdown = breakdownSchema.parse(row.breakdown) as CaptureProbabilityBreakdown;
    const placement: CaptureRosterPlacement | null =
      row.placement_kind === null || row.slot_no === null
        ? null
        : { placementKind: row.placement_kind, boxNo: row.box_no, slotNo: row.slot_no };
    return {
      id: row.id,
      playerId: playerId(row.player_id),
      encounterId: encounterId(row.encounter_id),
      battleId: row.battle_id,
      ballItemId: row.ball_item_id,
      targetWildNo: row.target_wild_no,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      sourceEncounterStatus: source,
      correlationId: row.correlation_id,
      status,
      probabilityBasisPoints: row.probability_basis_points,
      rollBasisPoints: row.roll_basis_points,
      pokemonInstanceId:
        row.pokemon_instance_id === null ? null : pokemonId(row.pokemon_instance_id),
      placement,
      breakdown,
      resolvedAt: row.resolved_at,
    };
  }

  public async loadContext(
    playerIdValue: PlayerId,
    encounterIdValue: EncounterId,
    ballItemId: string,
    targetWildNo = 1,
  ): Promise<CaptureContext | null> {
    const encounter = await this.client.query<{
      player_status: string;
      onboarding_state: string;
      encounter_id: string;
      encounter_status: string;
      revision: string;
      content_release_id: string;
      ruleset_id: string;
      ruleset_config: unknown;
      pokemon_snapshot: unknown;
      catch_rate: number | null;
    }>(
      `SELECT player.status AS player_status,
              onboarding.state AS onboarding_state,
              encounter.id AS encounter_id,
              encounter.status AS encounter_status,
              encounter.revision::text,
              encounter.content_release_id,
              encounter.ruleset_id,
              ruleset.config AS ruleset_config,
              wild.pokemon_snapshot,
              species.catch_rate
       FROM encounters encounter
       JOIN players player ON player.id = encounter.player_id
       JOIN onboarding_states onboarding ON onboarding.player_id = player.id
       JOIN encounter_wild_snapshots wild
         ON wild.encounter_id = encounter.id
        AND wild.wild_no = $3
        AND wild.status = 'ACTIVE'
       JOIN content_releases release
         ON release.id = encounter.content_release_id
        AND release.status IN ('PUBLISHED', 'ARCHIVED')
       JOIN rulesets ruleset
         ON ruleset.id = encounter.ruleset_id
        AND ruleset.status IN ('PUBLISHED', 'ARCHIVED')
       JOIN pokemon_species_revisions species
         ON species.content_release_id = encounter.content_release_id
        AND species.species_id = (wild.pokemon_snapshot ->> 'speciesId')::uuid
        AND species.active = TRUE
       WHERE encounter.id = $1 AND encounter.player_id = $2
         AND encounter.status IN ('ENGAGED', 'IN_BATTLE')
       FOR UPDATE OF encounter, player, wild`,
      [encounterIdValue, playerIdValue, targetWildNo],
    );
    const row = encounter.rows[0];
    if (row === undefined || row.catch_rate === null) return null;
    const snapshot = WildPokemonSnapshotSchema.parse(row.pokemon_snapshot);
    const sourceStatus = CaptureSourceStatusSchema.parse(row.encounter_status);

    const item = await this.client.query<{
      item_kind: string;
      effect_key: string | null;
      effect_config: unknown;
    }>(
      `SELECT item_kind, effect_key, effect_config
       FROM item_revisions
       WHERE content_release_id = $1 AND item_id = $2 AND active = TRUE`,
      [row.content_release_id, ballItemId],
    );
    const itemRow = item.rows[0];
    if (itemRow === undefined) return null;

    let battleId: string | null = null;
    let battleState: BattleState | null = null;
    if (sourceStatus === "IN_BATTLE") {
      const battle = await this.client.query<{
        id: string;
        status: string;
        battle_type: string;
        version: string;
      }>(
        `SELECT id, status, battle_type, version::text
         FROM battles
         WHERE encounter_id = $1
         ORDER BY created_at DESC
         LIMIT 2
         FOR UPDATE`,
        [encounterIdValue],
      );
      if (battle.rows.length !== 1)
        throw new Error("IN_BATTLE encounter must have exactly one battle root");
      const battleRow = battle.rows[0];
      if (
        battleRow === undefined ||
        battleRow.status !== "ACTIVE" ||
        battleRow.battle_type !== "WILD"
      ) {
        throw new Error("IN_BATTLE encounter points to a non-active wild battle");
      }
      const version = safeVersion(battleRow.version);
      const state = await this.client.query<{ state: unknown }>(
        `SELECT state FROM battle_state_snapshots WHERE battle_id = $1 AND version = $2`,
        [battleRow.id, version],
      );
      const stateRow = state.rows[0];
      if (stateRow === undefined) throw new Error("Active battle is missing its current snapshot");
      battleState = BattleStateSchema.parse(stateRow.state);
      if (battleState.version !== version)
        throw new Error("Battle root and snapshot version diverged");
      battleId = battleRow.id;
    }

    return {
      playerId: playerIdValue,
      playerActive: row.player_status === "ACTIVE",
      onboardingComplete: row.onboarding_state === "COMPLETE",
      encounterId: encounterId(row.encounter_id),
      encounterRevision: BigInt(row.revision),
      sourceStatus,
      contentReleaseId: row.content_release_id,
      rulesetId: row.ruleset_id,
      rulesetConfig: row.ruleset_config,
      catchRate: row.catch_rate,
      encounterSnapshot: snapshot,
      targetWildNo,
      battleId,
      battleState,
      ball: {
        itemId: ballItemId,
        itemKind: itemRow.item_kind,
        effectKey: itemRow.effect_key,
        effectConfig: itemRow.effect_config,
      },
      explicitModifierBasisPoints: [],
    };
  }

  public async beginResolving(input: {
    readonly playerId: PlayerId;
    readonly encounterId: EncounterId;
    readonly sourceStatus: "ENGAGED" | "IN_BATTLE";
    readonly expectedRevision: bigint;
  }): Promise<bigint | null> {
    const result = await this.client.query<{ revision: string }>(
      `UPDATE encounters
       SET status = 'CAPTURE_RESOLVING', revision = revision + 1, updated_at = now()
       WHERE id = $1 AND player_id = $2 AND status = $3 AND revision = $4
       RETURNING revision::text`,
      [input.encounterId, input.playerId, input.sourceStatus, input.expectedRevision.toString()],
    );
    const revision = result.rows[0]?.revision;
    return revision === undefined ? null : BigInt(revision);
  }

  public async insertPending(input: CapturePendingWrite): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO capture_attempts(
         id, player_id, encounter_id, battle_id, ball_item_id, target_wild_no, idempotency_key,
         status, probability_basis_points, roll_basis_points,
         request_fingerprint, source_encounter_status, correlation_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
         rng_counter, breakdown
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         'PENDING', $8, $9,
         $10, $11, $12,
         $13, $14, $15, $16,
         $17::bigint, $18::jsonb
       )
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        input.attemptId,
        input.playerId,
        input.encounterId,
        input.battleId,
        input.ballItemId,
        input.targetWildNo ?? 1,
        input.idempotencyStorageKey,
        input.probabilityBasisPoints,
        input.rollBasisPoints,
        input.requestFingerprint,
        input.sourceEncounterStatus,
        input.correlationId,
        Buffer.from(input.seed.ciphertext),
        Buffer.from(input.seed.iv),
        Buffer.from(input.seed.authTag),
        input.seed.keyVersion,
        input.rngCounter.toString(),
        JSON.stringify(input.breakdown),
      ],
    );
    return result.rowCount === 1;
  }

  public async consumeBall(input: {
    readonly attemptId: string;
    readonly playerId: PlayerId;
    readonly ballItemId: string;
    readonly idempotencyStorageKey: string;
    readonly correlationId: string;
  }): Promise<CaptureBallConsumeResult> {
    const ledger = await this.client.query(
      `INSERT INTO inventory_ledger(
         id, player_id, item_id, delta, source_type, source_id, reason,
         actor_type, actor_id, idempotency_scope, idempotency_key, correlation_id
       ) VALUES ($1, $2, $3, -1, 'CAPTURE_ATTEMPT', $4, 'Capture Ball consumption',
                 'PLAYER', $2, 'capture.consume', $5, $6)
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.playerId,
        input.ballItemId,
        input.attemptId,
        input.idempotencyStorageKey,
        input.correlationId,
      ],
    );
    if (ledger.rowCount !== 1) return "CLAIM_CONFLICT";

    const balance = await this.client.query(
      `UPDATE inventory_balances
       SET quantity = quantity - 1, revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND item_id = $2 AND quantity >= 1`,
      [input.playerId, input.ballItemId],
    );
    return balance.rowCount === 1 ? "CONSUMED" : "INSUFFICIENT";
  }

  public async nextRosterPlacement(playerIdValue: PlayerId): Promise<CaptureRosterPlacement> {
    return nextCanonicalRosterPlacement(this.client, playerIdValue);
  }

  private async insertOutbox(input: {
    readonly attemptId: string;
    readonly playerId: PlayerId;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key,
         status, correlation_id, causation_id
       ) VALUES ($1, 'INTERNAL', $2, 'CAPTURE_RESULT', $3::jsonb, $4, 'PENDING', $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.playerId,
        JSON.stringify(input.payload),
        `capture.result:${input.attemptId}`,
        input.correlationId,
        input.causationId,
      ],
    );
  }

  public async resolveFailure(input: CaptureFailureWrite): Promise<void> {
    const attempt = await this.client.query(
      `UPDATE capture_attempts
       SET status = 'FAILED', resolved_at = now()
       WHERE id = $1 AND player_id = $2 AND encounter_id = $3 AND status = 'PENDING'`,
      [input.attemptId, input.playerId, input.encounterId],
    );
    if (attempt.rowCount !== 1) throw new Error("Capture failure could not finalize attempt");

    const encounter = await this.client.query(
      `UPDATE encounters
       SET status = $4, revision = revision + 1, updated_at = now()
       WHERE id = $1 AND player_id = $2 AND status = 'CAPTURE_RESOLVING' AND revision = $3`,
      [
        input.encounterId,
        input.playerId,
        input.resolvingEncounterRevision.toString(),
        input.sourceEncounterStatus,
      ],
    );
    if (encounter.rowCount !== 1)
      throw new Error("Capture failure could not restore encounter state");

    await this.insertOutbox({
      attemptId: input.attemptId,
      playerId: input.playerId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: {
        schemaVersion: 1,
        captureAttemptId: input.attemptId,
        encounterId: input.encounterId,
        status: "FAILED",
        probabilityBasisPoints: input.probabilityBasisPoints,
        rollBasisPoints: input.rollBasisPoints,
      },
    });
  }

  private async cancelTurnWindow(battleId: string, battleVersion: number): Promise<void> {
    await this.client.query(
      `UPDATE battle_turn_submissions
       SET status = 'REJECTED'
       WHERE turn_window_id IN (
         SELECT id FROM battle_turn_windows
         WHERE battle_id = $1 AND battle_version = $2
       )
         AND status = 'ACTIVE'`,
      [battleId, battleVersion],
    );
    await this.client.query(
      `UPDATE battle_turn_windows
       SET status = 'CANCELLED',
           locked_at = COALESCE(locked_at, now()),
           revision = revision + 1
       WHERE battle_id = $1
         AND battle_version = $2
         AND status IN ('COLLECTING', 'LOCKED')`,
      [battleId, battleVersion],
    );
  }

  private async appendBattleEvent(input: {
    readonly battleId: string;
    readonly battleVersion: number;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly causationId: string | null;
    readonly correlationId: string;
  }): Promise<void> {
    const seq = await this.client.query<{ next_seq: string }>(
      `SELECT (COALESCE(MAX(seq), 0) + 1)::text AS next_seq
       FROM battle_events
       WHERE battle_id = $1`,
      [input.battleId],
    );
    await this.client.query(
      `INSERT INTO battle_events(
         id, battle_id, seq, battle_version, event_type, payload, causation_id, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        randomUUID(),
        input.battleId,
        seq.rows[0]?.next_seq ?? "1",
        input.battleVersion,
        input.eventType,
        JSON.stringify(input.payload),
        input.causationId,
        input.correlationId,
      ],
    );
  }

  private async applyBattleCapture(
    input: CaptureSuccessWrite,
  ): Promise<{ readonly continues: boolean }> {
    if (input.sourceEncounterStatus !== "IN_BATTLE") return { continues: false };
    if (input.battleId === null || input.expectedBattleVersion === null) {
      throw new Error("Battle capture success is missing battle CAS context");
    }

    const root = await this.client.query<{ status: string; version: string }>(
      `SELECT status, version::text
       FROM battles
       WHERE id = $1
       FOR UPDATE`,
      [input.battleId],
    );
    const row = root.rows[0];
    if (row === undefined || row.status !== "ACTIVE") {
      throw new Error("Captured battle is no longer active");
    }
    const version = safeVersion(row.version);
    if (version !== input.expectedBattleVersion) {
      throw new Error("Captured battle version changed during transaction");
    }

    const snapshot = await this.client.query<{ state: unknown }>(
      `SELECT state
       FROM battle_state_snapshots
       WHERE battle_id = $1 AND version = $2`,
      [input.battleId, version],
    );
    const current = BattleStateSchema.parse(snapshot.rows[0]?.state);
    if (current.status !== "ACTIVE" || current.version !== version) {
      throw new Error("Captured battle snapshot is not active at expected version");
    }

    const wildSide = current.sides.find((side) =>
      current.combatants.some(
        (entry) => entry.sideNo === side.sideNo && entry.participantKind === "WILD_POKEMON",
      ),
    );
    if (wildSide === undefined) throw new Error("Captured battle has no wild side");

    const target = current.combatants.find(
      (entry) =>
        entry.participantId === wildSide.activeParticipantId &&
        entry.participantKind === "WILD_POKEMON",
    );
    const targetWildNo = input.targetWildNo ?? 1;
    if (target === undefined || target.rosterPosition !== targetWildNo || target.currentHp <= 0) {
      throw new Error("Capture target is not the active live wild participant");
    }

    for (const combatant of current.combatants) {
      if (
        combatant.participantKind === "WILD_POKEMON" &&
        combatant.participantId !== target.participantId &&
        combatant.currentHp <= 0
      ) {
        await this.client.query(
          `UPDATE encounter_wild_snapshots
           SET status = 'FAINTED', updated_at = now()
           WHERE encounter_id = $1
             AND wild_no = $2
             AND status = 'ACTIVE'`,
          [input.encounterId, combatant.rosterPosition],
        );
      }
    }

    await this.client.query(
      `UPDATE battle_participants
       SET active_member = FALSE
       WHERE id = $1 AND battle_id = $2 AND participant_kind = 'WILD_POKEMON'`,
      [target.participantId, input.battleId],
    );

    await this.cancelTurnWindow(input.battleId, version);

    const remaining = current.combatants
      .filter(
        (entry) =>
          entry.participantKind === "WILD_POKEMON" &&
          entry.participantId !== target.participantId &&
          entry.currentHp > 0,
      )
      .sort((left, right) => left.rosterPosition - right.rosterPosition);

    if (remaining.length === 0) {
      const next = cancelledState(current);
      const updated = await this.client.query(
        `UPDATE battles
         SET status = 'CANCELLED', version = $3, updated_at = now(), ended_at = now()
         WHERE id = $1 AND version = $2 AND status = 'ACTIVE'`,
        [input.battleId, version, next.version],
      );
      if (updated.rowCount !== 1) throw new Error("Capture battle cancellation CAS failed");
      await this.client.query(
        `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
         VALUES ($1, $2, 1, $3::jsonb)`,
        [input.battleId, next.version, JSON.stringify(next)],
      );
      await this.appendBattleEvent({
        battleId: input.battleId,
        battleVersion: next.version,
        eventType: "BattleEnded",
        payload: {
          status: "CANCELLED",
          reason: "POKEMON_CAPTURED",
          captureAttemptId: input.attemptId,
          targetWildNo,
        },
        causationId: input.causationId,
        correlationId: input.correlationId,
      });
      await this.client.query(`UPDATE battle_sides SET result = 'CANCELLED' WHERE battle_id = $1`, [
        input.battleId,
      ]);
      return { continues: false };
    }

    const next = structuredClone(current);
    next.version += 1;
    next.combatants = next.combatants.filter(
      (entry) => entry.participantId !== target.participantId,
    );
    const side = next.sides.find((entry) => entry.sideNo === wildSide.sideNo);
    if (side === undefined) throw new Error("Wild side disappeared during capture");
    if (side.slots !== undefined) {
      throw new Error("Multi-wild capture does not support slot-mapped wild sides");
    }
    side.participantIds = side.participantIds.filter(
      (participantId) => participantId !== target.participantId,
    );
    const nextActive = remaining[0];
    if (nextActive === undefined) throw new Error("Capture continuation has no next wild");
    side.activeParticipantId = nextActive.participantId;

    const parsedNext = BattleStateSchema.parse(next);
    const updated = await this.client.query(
      `UPDATE battles
       SET version = $3, updated_at = now()
       WHERE id = $1 AND version = $2 AND status = 'ACTIVE'`,
      [input.battleId, version, parsedNext.version],
    );
    if (updated.rowCount !== 1) throw new Error("Capture battle continuation CAS failed");

    await this.client.query(
      `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
       VALUES ($1, $2, 1, $3::jsonb)`,
      [input.battleId, parsedNext.version, JSON.stringify(parsedNext)],
    );
    await this.appendBattleEvent({
      battleId: input.battleId,
      battleVersion: parsedNext.version,
      eventType: "PokemonCaptured",
      payload: {
        captureAttemptId: input.attemptId,
        participantId: target.participantId,
        targetWildNo,
        nextActiveParticipantId: nextActive.participantId,
      },
      causationId: input.causationId,
      correlationId: input.correlationId,
    });

    if (this.turnWindowTtlMs !== undefined) {
      const openedAt = new Date();
      const window = await openControllerTurnWindowInTransaction(this.client, {
        id: randomUUID(),
        battleId: input.battleId,
        battleVersion: parsedNext.version,
        turnNumber: parsedNext.turnNumber,
        openedAt,
        deadlineAt: new Date(openedAt.getTime() + this.turnWindowTtlMs),
      });
      if (!window.ok) {
        throw new Error(`Capture continuation could not open turn window: ${window.error.message}`);
      }
    }

    return { continues: true };
  }

  public async resolveSuccess(input: CaptureSuccessWrite): Promise<void> {
    const snapshot = input.encounterSnapshot;
    await this.client.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, level, current_hp, gender, shiny, ability_id,
         origin_type, origin_id, captured_at, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 'CAPTURE', $9, now(), $10::jsonb)`,
      [
        input.pokemonInstanceId,
        input.playerId,
        snapshot.formId,
        snapshot.level,
        input.captured.currentHp,
        snapshot.gender,
        snapshot.shiny,
        snapshot.abilityId,
        input.attemptId,
        JSON.stringify({
          captureAttemptId: input.attemptId,
          encounterId: input.encounterId,
          battleId: input.battleId,
          targetWildNo: input.targetWildNo ?? 1,
          contentReleaseId: input.contentReleaseId,
          rulesetId: input.rulesetId,
        }),
      ],
    );
    await this.client.query(
      `INSERT INTO pokemon_training_values(
         pokemon_instance_id, nature_id, iv_hp, iv_attack, iv_defense,
         iv_sp_attack, iv_sp_defense, iv_speed
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.pokemonInstanceId,
        snapshot.natureId,
        snapshot.ivs.hp,
        snapshot.ivs.attack,
        snapshot.ivs.defense,
        snapshot.ivs.spAttack,
        snapshot.ivs.spDefense,
        snapshot.ivs.speed,
      ],
    );
    for (const [index, move] of input.captured.moves.entries()) {
      await this.client.query(
        `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
         VALUES ($1, $2, $3, $4)`,
        [input.pokemonInstanceId, index + 1, move.moveId, move.ppCurrent],
      );
    }
    await this.client.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        input.pokemonInstanceId,
        input.playerId,
        input.placement.placementKind,
        input.placement.boxNo,
        input.placement.slotNo,
      ],
    );
    if (input.captured.majorStatus !== null) {
      await this.client.query(
        `INSERT INTO pokemon_persistent_conditions(
           pokemon_instance_id, condition_key, source_type, source_id, data
         ) VALUES ($1, $2, 'CAPTURE', $3, $4::jsonb)`,
        [
          input.pokemonInstanceId,
          input.captured.majorStatus,
          input.attemptId,
          JSON.stringify({ fromBattle: input.battleId !== null }),
        ],
      );
    }
    await recordPokedexCaught(this.client, input.playerId, snapshot.speciesId);
    await this.client.query(
      `INSERT INTO pokemon_history_events(
         id, pokemon_instance_id, event_type, payload, actor_type, correlation_id
       ) VALUES ($1, $2, 'CAPTURED', $3::jsonb, 'PLAYER', $4)`,
      [
        randomUUID(),
        input.pokemonInstanceId,
        JSON.stringify({
          captureAttemptId: input.attemptId,
          encounterId: input.encounterId,
          battleId: input.battleId,
          targetWildNo: input.targetWildNo ?? 1,
          contentReleaseId: input.contentReleaseId,
          rulesetId: input.rulesetId,
        }),
        input.correlationId,
      ],
    );
    const attempt = await this.client.query(
      `UPDATE capture_attempts
       SET status = 'CAPTURED', pokemon_instance_id = $2, resolved_at = now()
       WHERE id = $1 AND status = 'PENDING'`,
      [input.attemptId, input.pokemonInstanceId],
    );
    if (attempt.rowCount !== 1) throw new Error("Capture success could not finalize attempt");

    const targetWildNo = input.targetWildNo ?? 1;
    const wild = await this.client.query(
      `UPDATE encounter_wild_snapshots
       SET status = 'CAPTURED', updated_at = now()
       WHERE encounter_id = $1 AND wild_no = $2 AND status = 'ACTIVE'`,
      [input.encounterId, targetWildNo],
    );
    if (wild.rowCount !== 1) throw new Error("Capture target wild roster row is not active");

    const battleResolution = await this.applyBattleCapture(input);
    const remaining = await this.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM encounter_wild_snapshots
       WHERE encounter_id = $1 AND status = 'ACTIVE'`,
      [input.encounterId],
    );
    const activeWilds = Number(remaining.rows[0]?.count ?? "0");
    if (!Number.isSafeInteger(activeWilds) || activeWilds < 0) {
      throw new Error("Capture wild roster count is invalid");
    }
    const terminal = activeWilds === 0;
    if (!terminal && input.sourceEncounterStatus === "IN_BATTLE" && !battleResolution.continues) {
      throw new Error("Capture roster and battle continuation diverged");
    }

    const encounter = await this.client.query(
      `UPDATE encounters
       SET status = $4,
           revision = revision + 1,
           updated_at = now(),
           closed_at = CASE WHEN $5::boolean THEN now() ELSE NULL END
       WHERE id = $1
         AND player_id = $2
         AND status = 'CAPTURE_RESOLVING'
         AND revision = $3`,
      [
        input.encounterId,
        input.playerId,
        input.resolvingEncounterRevision.toString(),
        terminal ? "CAPTURED" : input.sourceEncounterStatus,
        terminal,
      ],
    );
    if (encounter.rowCount !== 1) throw new Error("Capture success could not finalize encounter");

    await this.insertOutbox({
      attemptId: input.attemptId,
      playerId: input.playerId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: {
        schemaVersion: 1,
        captureAttemptId: input.attemptId,
        encounterId: input.encounterId,
        battleId: input.battleId,
        targetWildNo,
        status: "CAPTURED",
        encounterContinues: !terminal,
        probabilityBasisPoints: input.probabilityBasisPoints,
        rollBasisPoints: input.rollBasisPoints,
        pokemonInstanceId: input.pokemonInstanceId,
        placement: input.placement,
      },
    });
  }
}

export class PostgresCaptureRepository implements CaptureRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly turnWindowTtlMs?: number,
  ) {
    if (
      turnWindowTtlMs !== undefined &&
      (!Number.isSafeInteger(turnWindowTtlMs) || turnWindowTtlMs <= 0)
    ) {
      throw new Error("Capture turn window TTL must be a positive safe integer");
    }
  }

  public async transaction<T>(work: (transaction: CaptureTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      (client) => work(new PostgresCaptureTransaction(client, this.turnWindowTtlMs)),
      { isolationLevel: "READ COMMITTED" },
    );
  }
}
