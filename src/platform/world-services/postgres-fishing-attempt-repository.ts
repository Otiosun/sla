import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { WorldAreaConfigSchema } from "../../modules/catalog/world-contracts.js";
import {
  type FishingAttemptRepository,
  type FishingAttemptReserved,
  type FishingAttemptReservationResult,
  type FishingRarity,
  type ReserveFishingAttemptInput,
  fishingRarityForRoll,
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

function unavailable(playerId: PlayerId, reason: string): FishingAttemptReservationResult {
  return { kind: "FISHING_UNAVAILABLE", playerId, reason };
}

export class PostgresFishingAttemptRepository implements FishingAttemptRepository {
  public constructor(private readonly pool: Pool) {}

  public async reserveAttempt(
    input: ReserveFishingAttemptInput,
  ): Promise<FishingAttemptReservationResult> {
    if (input.idempotencyKey.trim().length < 1 || input.idempotencyKey.trim().length > 200) {
      throw new RangeError("Fishing idempotency key must contain 1 to 200 characters");
    }
    fishingRarityForRoll(input.roll);

    return withTransaction(this.pool, async (client) => {
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
         WHERE player_id = $1 AND fishing_day = CURRENT_DATE`,
        [input.playerId],
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
      const attemptNo = usedToday + 1;
      const attemptId = randomUUID();
      const inserted = await client.query<FishingAttemptRow>(
        `INSERT INTO fishing_attempts(
           id, player_id, content_release_id, area_id, fishing_day,
           attempt_no, idempotency_key, roll, rarity,
           fishing_point_name, encounter_table_slug
         ) VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8, $9, $10)
         RETURNING id::text, player_id::text, area_id::text, attempt_no, roll, rarity,
                   fishing_point_name, encounter_table_slug`,
        [
          attemptId,
          input.playerId,
          contextRow.content_release_id,
          contextRow.area_id,
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
    });
  }
}
