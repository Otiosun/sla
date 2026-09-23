import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type BattleState,
  BattleStateSchema,
  BattleStatusSchema,
} from "../../modules/battle/contracts.js";
import type { BattleRootRecord } from "../../modules/battle/ports.js";
import type {
  PersistPvpTurnResolutionInput,
  PersistPvpTurnResolutionResult,
  PvpTurnResolutionRepository,
  PvpTurnResolutionTransaction,
} from "../../modules/battle/pvp-turn-resolution.js";
import type { TurnWindowAggregate } from "../../modules/battle/turn-window.js";
import {
  ContentLifecycleStatusSchema,
  type RulesetSnapshot,
} from "../../modules/catalog/contracts.js";
import { withTransaction } from "../db/transaction.js";
import { loadParticipantControllersInTransaction } from "./postgres-battle-participant-controller-repository.js";
import { persistPlayerBattleState } from "./postgres-battle-player-state-writeback.js";
import {
  loadAggregateById,
  openControllerTurnWindowInTransaction,
} from "./postgres-battle-turn-window-repository.js";

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

function safeVersion(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside JS safe range`);
  }
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

export class PostgresPvpTurnResolutionTransaction implements PvpTurnResolutionTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async loadParticipantControllers(battleId: string) {
    return loadParticipantControllersInTransaction(this.client, battleId);
  }

  public async loadTurnWindow(
    turnWindowId: string,
    lock = false,
  ): Promise<TurnWindowAggregate | null> {
    return loadAggregateById(this.client, turnWindowId, lock);
  }

  public async loadBattleRoot(battleId: string, lock = false): Promise<BattleRootRecord | null> {
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

  public async loadBattleState(battleId: string, version: number): Promise<BattleState | null> {
    const result = await this.client.query<{ state: unknown }>(
      `SELECT state
       FROM battle_state_snapshots
       WHERE battle_id = $1 AND version = $2`,
      [battleId, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : BattleStateSchema.parse(row.state);
  }

  public async persistResolution(
    input: PersistPvpTurnResolutionInput,
  ): Promise<PersistPvpTurnResolutionResult> {
    if (
      input.lockedWindow.window.id !== input.committedWindow.window.id ||
      input.lockedWindow.window.status !== "LOCKED" ||
      input.committedWindow.window.status !== "COMMITTED" ||
      input.committedWindow.window.revision !== input.lockedWindow.window.revision + 1 ||
      input.committedWindow.window.resolvedBattleVersion !== input.nextState.version ||
      input.committedWindow.window.resolutionCorrelationId !== input.correlationId
    ) {
      throw new Error("PVP turn resolution window transition is inconsistent");
    }

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
      const currentRoot = await this.loadBattleRoot(input.battleId);
      if (currentRoot === null) throw new Error("Battle disappeared during PVP CAS conflict");
      const currentState = await this.loadBattleState(input.battleId, currentRoot.version);
      if (currentState === null) throw new Error("PVP battle CAS conflict has no current snapshot");
      return { kind: "VERSION_CONFLICT", currentState };
    }

    await this.client.query(
      `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
       VALUES ($1, $2, 1, $3::jsonb)`,
      [input.battleId, input.nextState.version, JSON.stringify(input.nextState)],
    );
    await persistPlayerBattleState(this.client, input.battleId, input.nextState);

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
          input.causationId,
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

    // BELL_CONTROLLER_WILD_TERMINAL_SYNC_V1: controller-window resolution is used by PVE too, not only PVP.
    // Mirror the canonical WILD terminal synchronization from the direct battle path.
    if (input.nextState.battleType === "WILD") {
      let wildEncounterId = input.nextState.encounterId;
      if (wildEncounterId === null) {
        const battleEncounter = await this.client.query<{ encounter_id: string | null }>(
          "SELECT encounter_id FROM battles WHERE id = $1",
          [input.battleId],
        );
        wildEncounterId = battleEncounter.rows[0]?.encounter_id ?? null;
      }

      if (wildEncounterId !== null) {
        for (const combatant of input.nextState.combatants) {
          if (combatant.participantKind === "WILD_POKEMON" && combatant.currentHp <= 0) {
            await this.client.query(
              `UPDATE encounter_wild_snapshots
               SET status = 'FAINTED', updated_at = now()
               WHERE encounter_id = $1
                 AND wild_no = $2
                 AND status = 'ACTIVE'`,
              [wildEncounterId, combatant.rosterPosition],
            );
          }
        }

        if (terminal) {
          await this.client.query(
            `UPDATE encounter_wild_snapshots
             SET status = 'FLED', updated_at = now()
             WHERE encounter_id = $1 AND status = 'ACTIVE'`,
            [wildEncounterId],
          );
          const encounterTerminalStatus = input.nextState.status === "FLED" ? "FLED" : "CLOSED";
          await this.client.query(
            `UPDATE encounters
             SET status = $2,
                 revision = revision + 1,
                 updated_at = now(),
                 closed_at = now()
             WHERE id = $1 AND status = 'IN_BATTLE'`,
            [wildEncounterId, encounterTerminalStatus],
          );
        }
      }
    }

    const activeSubmissionIds = input.lockedWindow.submissions
      .filter((entry) => entry.status === "ACTIVE")
      .map((entry) => entry.id);
    const committedSubmissionIds = input.committedWindow.submissions
      .filter((entry) => entry.status === "COMMITTED")
      .map((entry) => entry.id);
    if (
      (activeSubmissionIds.length === 0 &&
        input.lockedWindow.window.requiredControllers?.length !== 0) ||
      activeSubmissionIds.length !== committedSubmissionIds.length ||
      activeSubmissionIds.some((id) => !committedSubmissionIds.includes(id))
    ) {
      throw new Error("PVP committed submissions do not match the locked active set");
    }

    const submissionsUpdated = await this.client.query(
      `UPDATE battle_turn_submissions
       SET status = 'COMMITTED'
       WHERE turn_window_id = $1
         AND status = 'ACTIVE'
         AND id = ANY($2::uuid[])`,
      [input.lockedWindow.window.id, activeSubmissionIds],
    );
    if (submissionsUpdated.rowCount !== activeSubmissionIds.length) {
      throw new Error("PVP turn submission commit CAS failed");
    }

    const window = input.committedWindow.window;
    const windowUpdated = await this.client.query(
      `UPDATE battle_turn_windows
       SET status = 'COMMITTED',
           committed_at = $3,
           revision = $4,
           resolution_correlation_id = $5,
           resolved_battle_version = $6
       WHERE id = $1
         AND status = 'LOCKED'
         AND revision = $2`,
      [
        window.id,
        input.lockedWindow.window.revision,
        window.committedAt,
        window.revision,
        window.resolutionCorrelationId,
        window.resolvedBattleVersion,
      ],
    );
    if (windowUpdated.rowCount !== 1) {
      throw new Error("PVP turn window commit CAS failed");
    }

    if (input.nextState.status === "LOST" && window.requiredControllers !== undefined) {
      await this.client.query(
        `INSERT INTO battle_defeat_aftermath(battle_id, battle_version) VALUES ($1, $2)`,
        [input.battleId, input.nextState.version],
      );
    }
    if (terminal) {
      await this.client.query(
        `UPDATE encounters
         SET status = 'CLOSED', closed_at = now(), updated_at = now(), revision = revision + 1
         FROM battles
         WHERE battles.id = $1
           AND battles.battle_type = 'PVP'
           AND encounters.id = battles.encounter_id
           AND encounters.status = 'IN_BATTLE'`,
        [input.battleId],
      );
    }
    if (!terminal && window.requiredControllers !== undefined) {
      if (window.committedAt === null) throw new Error("Committed window has no commit timestamp");
      const openedAt = new Date(window.committedAt);
      const duration = Date.parse(window.deadlineAt) - Date.parse(window.openedAt);
      const next = await openControllerTurnWindowInTransaction(this.client, {
        id: randomUUID(),
        battleId: input.battleId,
        battleVersion: input.nextState.version,
        turnNumber: input.nextState.turnNumber,
        openedAt,
        deadlineAt: new Date(openedAt.getTime() + duration),
      });
      if (!next.ok) throw new Error(`Next controller turn window failed: ${next.error.message}`);
    }
    return { kind: "PERSISTED", state: input.nextState };
  }
}

export class PostgresPvpTurnResolutionRepository implements PvpTurnResolutionRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    work: (transaction: PvpTurnResolutionTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresPvpTurnResolutionTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }
}
