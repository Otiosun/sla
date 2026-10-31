import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EncounterService } from "../../modules/encounter/service.js";
import { fishingDayKey } from "../../modules/world-services/fishing-calendar.js";
import { encounterRepositoryWithinTransaction } from "../encounter/postgres-encounter-repository.js";
import type { EncounterSeedProvider } from "../../modules/encounter/ports.js";
import type { EncounterView } from "../../modules/encounter/contracts.js";
import type { Clock } from "../clock/index.js";
import type { FeatureAvailability } from "../../shared-kernel/gates.js";
import { appError, err, ok, type AppError, type Result } from "../../shared-kernel/result.js";
import { WorldAreaConfigSchema } from "../../modules/catalog/world-contracts.js";
import {
  type FishingAttemptRepository,
  type FishingAttemptReservationResult,
  type FishingAttemptReserved,
  type FishingRarity,
  fishingRarityForRoll,
  type ReserveFishingAttemptInput,
} from "../../modules/world-services/fishing-service.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

const DAILY_LIMIT = 5;
const ACTIVE_ENCOUNTER_STATUSES = [
  "CREATED",
  "PRESENTED",
  "ENGAGED",
  "CAPTURE_RESOLVING",
  "IN_BATTLE",
] as const;
const ACTIVE_BATTLE_STATUSES = ["CREATED", "ACTIVE", "RESOLVING_TURN"] as const;

interface FishingAttemptRow {
  readonly id: string;
  readonly player_id: string;
  readonly area_id: string;
  readonly attempt_no: number;
  readonly roll: number;
  readonly rarity: FishingRarity | null;
  readonly fishing_point_name: string;
  readonly encounter_table_slug: string | null;
}

function reserved(
  row: FishingAttemptRow,
  playerId: PlayerId,
  replayed: boolean,
): FishingAttemptReserved {
  return {
    kind: "RESERVED",
    attemptId: row.id,
    playerId,
    areaId: row.area_id,
    fishingPointName: row.fishing_point_name,
    attemptNo: row.attempt_no,
    dailyLimit: DAILY_LIMIT,
    remainingAttempts: DAILY_LIMIT - row.attempt_no,
    roll: row.roll,
    rarity: row.rarity,
    encounterTableSlug: row.encounter_table_slug,
    replayed,
  };
}

class FishingAtomicRollback extends Error {
  public constructor(public readonly failure: AppError) {
    super(failure.message);
  }
}

function unavailable(playerId: PlayerId, reason: string): FishingAttemptReservationResult {
  return { kind: "FISHING_UNAVAILABLE", playerId, reason };
}

export class PostgresFishingAttemptRepository implements FishingAttemptRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly config: {
      readonly clock: Clock;
      /** Approved world timezone, required even in non-encounter legacy proofs. */
      readonly fishingDayTimeZone: string;
      readonly seedProvider?: EncounterSeedProvider;
      readonly feature?: FeatureAvailability;
    },
  ) {
    // Reject invalid configuration before any SQL/attempt or quota mutation.
    fishingDayKey(config.clock.now(), config.fishingDayTimeZone);
  }

  public async reserveAttempt(
    input: ReserveFishingAttemptInput,
  ): Promise<FishingAttemptReservationResult> {
    return withTransaction(this.pool, client => this.reserveWithin(client, input));
  }

  /**
   * The operational fishing path: the per-player daily quota and encounter
   * creation share a single PoolClient, lock and COMMIT. Failed encounter
   * results throw the private rollback sentinel, which withTransaction
   * converts into a PostgreSQL ROLLBACK before returning a domain error.
   */
  public async reserveAndResolve(input: ReserveFishingAttemptInput): Promise<Result<{
    readonly reservation: FishingAttemptReservationResult;
    readonly encounter: EncounterView | null;
  }>> {
    const config = this.config;
    if (config.seedProvider === undefined || config.feature === undefined) {
      return err(appError("FEATURE_UNAVAILABLE", "Atomic fishing encounter dependencies are missing"));
    }
    try {
      return await withTransaction(this.pool, async client => {
        const reservation = await this.reserveWithin(client, input);
        if (reservation.kind !== "RESERVED" || reservation.rarity === null) {
          return ok({ reservation, encounter: null });
        }
        if (reservation.encounterTableSlug === null) {
          throw new FishingAtomicRollback(appError(
            "FLOW_BLOCKED", "Fishing encounter table was not persisted",
          ));
        }
        const encounter = await new EncounterService(
          encounterRepositoryWithinTransaction(client),
          config.seedProvider,
          config.clock,
          config.feature,
        ).createOrReplay({
          playerId: input.playerId,
          idempotencyKey: `fishing:${reservation.attemptId}`,
          encounterTableSlug: reservation.encounterTableSlug,
          environment: { surface: "WATER" },
        });
        if (!encounter.ok) throw new FishingAtomicRollback(encounter.error);
        if (encounter.value.playerId !== input.playerId ||
            encounter.value.areaId !== reservation.areaId) {
          throw new FishingAtomicRollback(appError(
            "FLOW_BLOCKED", "Fishing encounter is not in the reserved area",
          ));
        }
        return ok({ reservation, encounter: encounter.value });
      });
    } catch (error) {
      if (error instanceof FishingAtomicRollback) return err(error.failure);
      throw error;
    }
  }

  private async reserveWithin(
    client: PoolClient,
    input: ReserveFishingAttemptInput,
  ): Promise<FishingAttemptReservationResult> {
    if (input.idempotencyKey.trim().length < 1 || input.idempotencyKey.trim().length > 200) {
      throw new RangeError("Fishing idempotency key must contain 1 to 200 characters");
    }
    fishingRarityForRoll(input.roll);
    // Frozen day for this one attempt, independent of PostgreSQL/host timezone.
    const fishingDay = fishingDayKey(this.config.clock.now(), this.config.fishingDayTimeZone);

      const player = await client.query<{ status: string }>(
        "SELECT status FROM players WHERE id = $1 FOR UPDATE",
        [input.playerId],
      );
      const playerRow = player.rows[0];
      if (playerRow === undefined || playerRow.status !== "ACTIVE") {
        return unavailable(input.playerId, "Player is not active");
      }

      const replay = await client.query<FishingAttemptRow>(
        `SELECT id::text, player_id::text, area_id::text, attempt_no, roll, rarity,
                fishing_point_name, encounter_table_slug
         FROM fishing_attempts
         WHERE player_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.playerId, input.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) return reserved(replayRow, input.playerId, true);

      const context = await client.query<{
        area_id: string;
        content_release_id: string;
        area_data: unknown;
      }>(
        `SELECT location.area_id::text AS area_id,
                pointer.content_release_id::text AS content_release_id,
                revision.data AS area_data
         FROM player_locations location
         JOIN content_release_pointers pointer
           ON pointer.pointer_key = 'ACTIVE'
         JOIN content_releases release
           ON release.id = pointer.content_release_id
          AND release.status = 'PUBLISHED'
         JOIN area_revisions revision
           ON revision.content_release_id = pointer.content_release_id
          AND revision.area_id = location.area_id
          AND revision.active = TRUE
         WHERE location.player_id = $1`,
        [input.playerId],
      );
      const contextRow = context.rows[0];
      if (contextRow === undefined) {
        return unavailable(input.playerId, "Player location or active content is unavailable");
      }

      const areaConfig = WorldAreaConfigSchema.safeParse(contextRow.area_data);
      if (!areaConfig.success) {
        throw new Error(`Published fishing area ${contextRow.area_id} has invalid world config`);
      }
      const fishing = areaConfig.data.fishing;
      if (fishing === undefined) {
        return unavailable(input.playerId, "Fishing is not configured for the current area");
      }

      const flow = await client.query<{ active_encounter: boolean; active_battle: boolean }>(
        `SELECT
           EXISTS (
             SELECT 1
             FROM encounters encounter
             WHERE encounter.player_id = $1
               AND encounter.status = ANY($2::text[])
           ) AS active_encounter,
           EXISTS (
             SELECT 1
             FROM battle_sides side
             JOIN battles battle ON battle.id = side.battle_id
             WHERE side.player_id = $1
               AND battle.status = ANY($3::text[])
           ) AS active_battle`,
        [input.playerId, ACTIVE_ENCOUNTER_STATUSES, ACTIVE_BATTLE_STATUSES],
      );
      const flowRow = flow.rows[0];
      if (flowRow?.active_encounter || flowRow?.active_battle) {
        return unavailable(input.playerId, "Player has an incompatible active encounter or battle");
      }

      const used = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM fishing_attempts
         WHERE player_id = $1 AND fishing_day = $2::date`,
        [input.playerId, fishingDay],
      );
      const usedToday = Number(used.rows[0]?.count ?? "0");
      if (usedToday >= DAILY_LIMIT) {
        return {
          kind: "DAILY_LIMIT_REACHED",
          playerId: input.playerId,
          dailyLimit: DAILY_LIMIT,
          remainingAttempts: 0,
        };
      }

      const rarity = fishingRarityForRoll(input.roll);
      const encounterTableSlug = rarity === null ? null : (fishing.encounterTables[rarity] ?? null);
      if (rarity !== null && encounterTableSlug === null) {
        return unavailable(
          input.playerId,
          `Fishing ${rarity} encounter pool is not configured for the current area`,
        );
      }

      const attemptNo = usedToday + 1;
      const attemptId = randomUUID();
      const inserted = await client.query<FishingAttemptRow>(
        `INSERT INTO fishing_attempts(
           id, player_id, content_release_id, area_id, fishing_day,
           attempt_no, idempotency_key, roll, rarity,
           fishing_point_name, encounter_table_slug
         ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11)
         RETURNING id::text, player_id::text, area_id::text, attempt_no, roll, rarity,
                   fishing_point_name, encounter_table_slug`,
        [
          attemptId,
          input.playerId,
          contextRow.content_release_id,
          contextRow.area_id,
          fishingDay,
          attemptNo,
          input.idempotencyKey,
          input.roll,
          rarity,
          fishing.pointName,
          encounterTableSlug,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) throw new Error("Fishing attempt insert returned no row");
      return reserved(insertedRow, input.playerId, false);
  }
}
