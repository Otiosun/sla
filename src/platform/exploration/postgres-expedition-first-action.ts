import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { advanceExpedition, type ExpeditionSnapshot } from "../../modules/exploration/expedition-state.js";
import { expeditionWeekKey } from "../../modules/exploration/expedition-week.js";
import type { Clock } from "../clock/index.js";
import { withTransaction } from "../db/transaction.js";
import { publishedExplorationAreasInTransaction } from "./postgres-published-exploration-areas.js";
import { createIdempotencyKey, parseIdempotencyScope } from "../../shared-kernel/idempotency.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type AppError, type Result } from "../../shared-kernel/result.js";

const scope = parseIdempotencyScope("solo.exploration.first-action");
if (!scope.ok) throw new Error("Invalid first-action scope");

interface StoredExpeditionRow {
  readonly id: string;
  readonly player_id: string;
  readonly period: "DAY" | "NIGHT";
  readonly area_id: string;
  readonly phase: "PREPARING" | "ACTIVE" | "ENDED";
  readonly elapsed_minutes: number;
  readonly consumed_week_key: string | null;
  readonly end_reason: "CANCELLED" | "VOLUNTARY" | "CLOCK" | "BLACKOUT" | null;
  readonly revision: string;
}

interface FirstActionStoredResult {
  readonly expedition: Omit<ExpeditionSnapshot, "revision"> & { readonly revision: string };
  readonly consumedWeeklySlot: true;
  readonly changed: true;
  readonly effectResult: unknown;
}

interface ReceiptRow {
  readonly fingerprint: string;
  readonly result: FirstActionStoredResult;
}

interface WorldLocationRow {
  readonly area_id: string;
  readonly revision: string;
}

export interface FirstActionContext {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly areaId: string;
  readonly contentReleaseId: string;
  readonly idempotencyKey: string;
}

export interface FirstActionEffect {
  /** A reviewed, deterministic action identifier. No arbitrary WhatsApp text. */
  readonly actionKey: string;
  /** SHA-256 of the validated canonical action parameters. */
  readonly actionFingerprint: string;
  /**
   * SQL-only action effect using the supplied transaction connection.
   * No HTTP, WhatsApp delivery, separate Pool or external side effects.
   * A returned error or thrown exception rolls back quota, time and effect.
   */
  apply(client: PoolClient, context: FirstActionContext): Promise<Result<unknown>>;
}

export interface FirstActionInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly expectedLocationRevision: bigint;
  readonly expectedContentReleaseId: string;
  readonly minutes: number;
  /** Trusted caller supplies an Inbox-derived key, never message text. */
  readonly idempotencyKey: string;
  readonly effect: FirstActionEffect;
}

export interface FirstActionOutcome {
  readonly expedition: ExpeditionSnapshot;
  readonly consumedWeeklySlot: true;
  readonly changed: true;
  readonly effectResult: unknown;
  readonly replayed: boolean;
}

class RollbackAction extends Error {
  public constructor(public readonly reason: AppError) {
    super(reason.message);
  }
}

function blocked(message: string): Result<never> {
  return err(appError("FLOW_BLOCKED", message));
}

function snapshot(row: StoredExpeditionRow): ExpeditionSnapshot {
  return {
    expeditionId: row.id,
    playerId: row.player_id,
    period: row.period,
    areaId: row.area_id,
    phase: row.phase,
    elapsedMinutes: row.elapsed_minutes,
    consumedWeekKey: row.consumed_week_key,
    endReason: row.end_reason,
    revision: BigInt(row.revision),
  };
}

function fingerprint(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function restore(value: FirstActionStoredResult, replayed: boolean): FirstActionOutcome {
  return {
    ...value,
    expedition: { ...value.expedition, revision: BigInt(value.expedition.revision) },
    replayed,
  };
}

/**
 * Draft-only transactional seam. Nothing in the runtime or WhatsApp wires
 * this class yet. It DOES NOT define gameplay effects or action durations.
 *
 * All required World state is rechecked inside this write transaction.
 * The published-catalog preview from PR #248 is never treated as authority.
 */
export class PostgresExpeditionFirstAction {
  public constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly timeZone: string,
  ) {
    expeditionWeekKey(clock.now(), timeZone);
  }

  public async execute(input: FirstActionInput): Promise<Result<FirstActionOutcome>> {
    const { effect } = input;
    const key = createIdempotencyKey(scope.value, input.idempotencyKey);
    if (!key.ok) return key;
    if (
      !/^[a-z][a-z0-9._:-]{1,95}$/.test(effect.actionKey) ||
      !/^[a-f0-9]{64}$/.test(effect.actionFingerprint) ||
      !Number.isSafeInteger(input.minutes) ||
      input.minutes <= 0 ||
      input.minutes > 720 ||
      input.expectedRevision < 0n ||
      input.expectedLocationRevision < 0n
    ) {
      return err(appError("VALIDATION_FAILED", "Invalid canonical expedition action"));
    }
    const digest = fingerprint([
      "WORLD_FIRST_ACTION",
      input.expeditionId,
      input.expectedRevision.toString(),
      input.expectedLocationRevision.toString(),
      input.expectedContentReleaseId,
      input.minutes,
      effect.actionKey,
      effect.actionFingerprint,
    ]);

    try {
      return await withTransaction(this.pool, async (client) => {
        // Fixed order: published pointer -> player -> location -> expedition.
        // Pointer lock prevents publish/cutover during the first-action write.
        const published = await publishedExplorationAreasInTransaction(
          client,
          input.expectedContentReleaseId,
          true,
        );
        if (published === null) return blocked("Active published World release has changed");

        const player = await client.query<{ status: string; onboarding_state: string | null }>(
          `SELECT player.status, onboarding.state AS onboarding_state
             FROM players player
             LEFT JOIN onboarding_states onboarding ON onboarding.player_id=player.id
            WHERE player.id=$1 FOR UPDATE OF player`,
          [input.playerId],
        );
        if (player.rows[0]?.status !== "ACTIVE" || player.rows[0]?.onboarding_state !== "COMPLETE") {
          return err(appError("PLAYER_INELIGIBLE", "Trainer must be active with completed onboarding"));
        }

        // Always test the receipt under the player lock before comparing the
        // *current* revision/location: retries must replay historical success.
        const receipt = await client.query<ReceiptRow>(
          `SELECT fingerprint,result FROM solo_expedition_receipts
            WHERE player_id=$1 AND idempotency_key=$2`,
          [input.playerId, key.value.storageKey],
        );
        const previously = receipt.rows[0];
        if (previously !== undefined) {
          return previously.fingerprint === digest
            ? ok(restore(previously.result, true))
            : err(appError("FINGERPRINT_MISMATCH", "First-action key belongs to another payload"));
        }

        const location = await client.query<WorldLocationRow>(
          `SELECT area_id::text,revision::text FROM player_locations
            WHERE player_id=$1 FOR UPDATE`,
          [input.playerId],
        );
        const currentLocation = location.rows[0];
        if (currentLocation === undefined) return blocked("Player has no World location");
        if (BigInt(currentLocation.revision) !== input.expectedLocationRevision) {
          return err(appError("REVISION_CONFLICT", "World location changed during expedition"));
        }
        if (!published.encounterReadyAreaIds.includes(currentLocation.area_id)) {
          return blocked("Player area has no published encounters in active World release");
        }

        const flow = await client.query<{ busy: boolean }>(
          `SELECT (
               EXISTS (
                 SELECT 1 FROM encounters
                 WHERE player_id=$1 AND status IN
                   ('CREATED','PRESENTED','ENGAGED','CAPTURE_RESOLVING','IN_BATTLE')
               )
               OR EXISTS (
                 SELECT 1 FROM battle_sides side
                 JOIN battles battle ON battle.id=side.battle_id
                 WHERE side.player_id=$1 AND battle.status IN
                   ('CREATED','ACTIVE','RESOLVING_TURN')
               )
             ) AS busy`,
          [input.playerId],
        );
        if (flow.rows[0]?.busy !== false) return blocked("Trainer already has an encounter or battle");

        const rows = await client.query<StoredExpeditionRow>(
          `SELECT id::text,player_id::text,period,area_id::text,phase,
                  elapsed_minutes,consumed_week_key::text,end_reason,revision::text
             FROM solo_expeditions WHERE player_id=$1 AND id=$2 FOR UPDATE`,
          [input.playerId, input.expeditionId],
        );
        const originalRow = rows.rows[0];
        if (originalRow === undefined || originalRow.phase !== "PREPARING") {
          return blocked("First action requires a prepared expedition");
        }
        const expedition = snapshot(originalRow);
        if (expedition.areaId !== currentLocation.area_id) {
          return blocked("World location and prepared expedition area differ");
        }

        const weekKey = expeditionWeekKey(this.clock.now(), this.timeZone);
        const used = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM solo_expeditions
            WHERE player_id=$1 AND consumed_week_key=$2::date`,
          [input.playerId, weekKey],
        );
        const transition = advanceExpedition({
          expedition,
          expectedRevision: input.expectedRevision,
          minutes: input.minutes,
          weekKey,
          consumedThisWeek: Number(used.rows[0]?.count ?? "0"),
        });
        if (!transition.ok) return transition;
        if (!transition.value.changed || !transition.value.consumedWeeklySlot) {
          return blocked("First expedition action must consume exactly one slot");
        }

        const update = await client.query(
          `UPDATE solo_expeditions
              SET phase=$3,elapsed_minutes=$4,consumed_week_key=$5::date,
                  end_reason=$6,revision=$7::bigint,updated_at=now()
            WHERE id=$1 AND player_id=$2 AND revision=$8::bigint`,
          [
            input.expeditionId,
            input.playerId,
            transition.value.expedition.phase,
            transition.value.expedition.elapsedMinutes,
            transition.value.expedition.consumedWeekKey,
            transition.value.expedition.endReason,
            transition.value.expedition.revision.toString(),
            input.expectedRevision.toString(),
          ],
        );
        if (update.rowCount !== 1) {
          throw new RollbackAction(appError("REVISION_CONFLICT", "Expedition update lost its revision"));
        }

        const result = await effect.apply(client, {
          playerId: input.playerId,
          expeditionId: input.expeditionId,
          areaId: currentLocation.area_id,
          contentReleaseId: input.expectedContentReleaseId,
          idempotencyKey: key.value.storageKey,
        });
        if (!result.ok) throw new RollbackAction(result.error);

        const stored: FirstActionStoredResult = {
          expedition: {
            ...transition.value.expedition,
            revision: transition.value.expedition.revision.toString(),
          },
          consumedWeeklySlot: true,
          changed: true,
          effectResult: result.value,
        };
        // Serializing now ensures a non-JSON effect cannot commit its writes.
        const json = JSON.stringify(stored);
        await client.query(
          `INSERT INTO solo_expedition_receipts(
               player_id,idempotency_key,expedition_id,operation,fingerprint,result
             ) VALUES($1,$2,$3,'ADVANCE',$4,$5::jsonb)`,
          [input.playerId, key.value.storageKey, input.expeditionId, digest, json],
        );
        return ok(restore(stored, false));
      });
    } catch (error) {
      if (error instanceof RollbackAction) return err(error.reason);
      throw error;
    }
  }
}
