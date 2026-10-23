import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ExpeditionPeriod } from "../../modules/exploration/expedition-clock.js";
import {
  advanceExpedition,
  endExpedition,
  type ExpeditionEndReason,
  type ExpeditionPhase,
  type ExpeditionSnapshot,
  type ExpeditionTransition,
} from "../../modules/exploration/expedition-state.js";
import { expeditionWeekKey } from "../../modules/exploration/expedition-week.js";
import type { Clock } from "../clock/index.js";
import { withTransaction } from "../db/transaction.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

/**
 * Staging-only V1.1 lifecycle persistence. It intentionally does not wire
 * WhatsApp, grant rewards, move a player or execute encounter/battle effects.
 * Its draft schema lives outside the immutable production migration chain.
 */
export interface StoredExpeditionTransition extends ExpeditionTransition {
  readonly replayed: boolean;
}

interface ExpeditionRow {
  readonly id: string;
  readonly player_id: string;
  readonly period: ExpeditionPeriod;
  readonly area_id: string;
  readonly phase: ExpeditionPhase;
  readonly elapsed_minutes: number;
  readonly consumed_week_key: string | null;
  readonly end_reason: ExpeditionEndReason | null;
  readonly revision: string;
}

interface StoredOutcome {
  readonly expedition: Omit<ExpeditionSnapshot, "revision"> & { readonly revision: string };
  readonly consumedWeeklySlot: boolean;
  readonly changed: boolean;
}

interface ReceiptRow {
  readonly fingerprint: string;
  readonly result: StoredOutcome;
}

export interface PrepareExpeditionInput {
  readonly playerId: PlayerId;
  readonly period: ExpeditionPeriod;
  readonly idempotencyKey: string;
}

export interface AdvanceStoredExpeditionInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly minutes: number;
  readonly idempotencyKey: string;
}

export interface EndStoredExpeditionInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly reason: "CANCELLED" | "VOLUNTARY" | "BLACKOUT";
  readonly idempotencyKey: string;
}

function snapshot(row: ExpeditionRow): ExpeditionSnapshot {
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

function serialize(value: ExpeditionTransition): string {
  return JSON.stringify({
    ...value,
    expedition: { ...value.expedition, revision: value.expedition.revision.toString() },
  } satisfies StoredOutcome);
}

function restore(result: StoredOutcome, replayed: boolean): StoredExpeditionTransition {
  return {
    expedition: { ...result.expedition, revision: BigInt(result.expedition.revision) },
    consumedWeeklySlot: result.consumedWeeklySlot,
    changed: result.changed,
    replayed,
  };
}

function fingerprint(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function validateKey(key: string): Result<void> {
  return key.trim().length >= 1 && key.length <= 200
    ? ok(undefined)
    : err(appError("IDEMPOTENCY_KEY_INVALID", "Expedition key must be 1-200 characters"));
}

async function lockedPlayer(client: PoolClient, playerId: PlayerId): Promise<Result<void>> {
  const player = await client.query<{ status: string }>(
    "SELECT status FROM players WHERE id = $1 FOR UPDATE",
    [playerId],
  );
  return player.rows[0]?.status === "ACTIVE"
    ? ok(undefined)
    : err(appError("PLAYER_INELIGIBLE", "Only active trainers may start or change an expedition"));
}

async function replay(
  client: PoolClient,
  playerId: PlayerId,
  key: string,
  inputFingerprint: string,
): Promise<Result<StoredExpeditionTransition> | null> {
  const receipt = await client.query<ReceiptRow>(
    "SELECT fingerprint, result FROM solo_expedition_receipts WHERE player_id = $1 AND idempotency_key = $2",
    [playerId, key],
  );
  const existing = receipt.rows[0];
  if (existing === undefined) return null;
  return existing.fingerprint === inputFingerprint
    ? ok(restore(existing.result, true))
    : err(appError("IDEMPOTENCY_KEY_INVALID", "Expedition key reused for different operation"));
}

async function writeReceipt(
  client: PoolClient,
  playerId: PlayerId,
  key: string,
  expeditionId: string,
  operation: "PREPARE" | "ADVANCE" | "END",
  inputFingerprint: string,
  transition: ExpeditionTransition,
): Promise<StoredExpeditionTransition> {
  await client.query(
    "INSERT INTO solo_expedition_receipts(player_id,idempotency_key,expedition_id,operation,fingerprint,result) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [playerId, key, expeditionId, operation, inputFingerprint, serialize(transition)],
  );
  return { ...transition, replayed: false };
}

async function lockedExpedition(
  client: PoolClient,
  playerId: PlayerId,
  expeditionId: string,
): Promise<ExpeditionSnapshot | null> {
  const rows = await client.query<ExpeditionRow>(
    "SELECT id::text,player_id::text,period,area_id::text,phase,elapsed_minutes,consumed_week_key::text,end_reason,revision::text FROM solo_expeditions WHERE player_id=$1 AND id=$2 FOR UPDATE",
    [playerId, expeditionId],
  );
  return rows.rows[0] === undefined ? null : snapshot(rows.rows[0]);
}

async function persistSnapshot(
  client: PoolClient,
  value: ExpeditionSnapshot,
  expectedRevision: bigint,
): Promise<void> {
  const updated = await client.query(
    "UPDATE solo_expeditions SET phase=$3,elapsed_minutes=$4,consumed_week_key=$5::date,end_reason=$6,revision=$7::bigint,updated_at=now() WHERE id=$1 AND player_id=$2 AND revision=$8::bigint",
    [
      value.expeditionId,
      value.playerId,
      value.phase,
      value.elapsedMinutes,
      value.consumedWeekKey,
      value.endReason,
      value.revision.toString(),
      expectedRevision.toString(),
    ],
  );
  if (updated.rowCount !== 1) throw new Error("Expedition row was lost during locked transition");
}

function unavailable(): Result<never> {
  return err(appError("FLOW_BLOCKED", "No matching active expedition for this trainer"));
}

export class PostgresExpeditionRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly timeZone: string,
  ) {
    // Validate configuration at composition time, not after consuming a slot.
    expeditionWeekKey(clock.now(), timeZone);
  }

  public async current(playerId: PlayerId): Promise<ExpeditionSnapshot | null> {
    const result = await this.pool.query<ExpeditionRow>(
      "SELECT id::text,player_id::text,period,area_id::text,phase,elapsed_minutes,consumed_week_key::text,end_reason,revision::text FROM solo_expeditions WHERE player_id=$1 AND phase <> 'ENDED'",
      [playerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : snapshot(row);
  }

  public async prepare(input: PrepareExpeditionInput): Promise<Result<StoredExpeditionTransition>> {
    const validKey = validateKey(input.idempotencyKey);
    if (!validKey.ok) return validKey;
    if (input.period !== "DAY" && input.period !== "NIGHT") {
      return err(appError("VALIDATION_FAILED", "Unknown expedition period"));
    }
    const inputFingerprint = fingerprint(["PREPARE", input.period]);
    return withTransaction(this.pool, async (client) => {
      const player = await lockedPlayer(client, input.playerId);
      if (!player.ok) return player;
      const prior = await replay(client, input.playerId, input.idempotencyKey, inputFingerprint);
      if (prior !== null) return prior;

      const open = await client.query<{ id: string }>(
        "SELECT id::text FROM solo_expeditions WHERE player_id=$1 AND phase <> 'ENDED'",
        [input.playerId],
      );
      if (open.rows.length > 0) {
        return err(
          appError("FLOW_BLOCKED", "Resume or cancel your existing expedition first", {
            userMessage: "Você já tem uma expedição. Retome-a antes de iniciar outra.",
          }),
        );
      }
      const week = expeditionWeekKey(this.clock.now(), this.timeZone);
      const used = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key=$2::date",
        [input.playerId, week],
      );
      if (Number(used.rows[0]?.count ?? "0") >= 3) {
        return err(
          appError("FLOW_BLOCKED", "Expedition weekly limit reached", {
            userMessage: "Você já utilizou suas três expedições desta semana.",
          }),
        );
      }

      // World eligibility, unlocks and active-release content must be added
      // before exposing /explorar; this draft only binds the current location.
      const location = await client.query<{ area_id: string }>(
        "SELECT location.area_id::text FROM player_locations location JOIN areas area ON area.id=location.area_id WHERE location.player_id=$1",
        [input.playerId],
      );
      const areaId = location.rows[0]?.area_id;
      if (areaId === undefined) {
        return err(appError("FLOW_BLOCKED", "A verified trainer location is required"));
      }
      const expeditionId = randomUUID();
      await client.query(
        "INSERT INTO solo_expeditions(id,player_id,period,area_id,phase,elapsed_minutes,revision) VALUES ($1,$2,$3,$4,'PREPARING',0,0)",
        [expeditionId, input.playerId, input.period, areaId],
      );
      const expedition: ExpeditionSnapshot = {
        expeditionId,
        playerId: input.playerId,
        period: input.period,
        areaId,
        phase: "PREPARING",
        elapsedMinutes: 0,
        consumedWeekKey: null,
        endReason: null,
        revision: 0n,
      };
      return ok(
        await writeReceipt(
          client,
          input.playerId,
          input.idempotencyKey,
          expeditionId,
          "PREPARE",
          inputFingerprint,
          {
            expedition,
            consumedWeeklySlot: false,
            changed: true,
          },
        ),
      );
    });
  }

  public async advance(
    input: AdvanceStoredExpeditionInput,
  ): Promise<Result<StoredExpeditionTransition>> {
    const validKey = validateKey(input.idempotencyKey);
    if (!validKey.ok) return validKey;
    const inputFingerprint = fingerprint([
      "ADVANCE",
      input.expeditionId,
      input.expectedRevision.toString(),
      input.minutes,
    ]);
    return withTransaction(this.pool, async (client) => {
      const player = await lockedPlayer(client, input.playerId);
      if (!player.ok) return player;
      const prior = await replay(client, input.playerId, input.idempotencyKey, inputFingerprint);
      if (prior !== null) return prior;
      const original = await lockedExpedition(client, input.playerId, input.expeditionId);
      if (original === null) return unavailable();

      const week = expeditionWeekKey(this.clock.now(), this.timeZone);
      const used = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key=$2::date",
        [input.playerId, week],
      );
      const transition = advanceExpedition({
        expedition: original,
        expectedRevision: input.expectedRevision,
        minutes: input.minutes,
        weekKey: week,
        consumedThisWeek: Number(used.rows[0]?.count ?? "0"),
      });
      if (!transition.ok) return transition;
      if (transition.value.changed) {
        await persistSnapshot(client, transition.value.expedition, original.revision);
      }
      return ok(
        await writeReceipt(
          client,
          input.playerId,
          input.idempotencyKey,
          input.expeditionId,
          "ADVANCE",
          inputFingerprint,
          transition.value,
        ),
      );
    });
  }

  public async end(input: EndStoredExpeditionInput): Promise<Result<StoredExpeditionTransition>> {
    const validKey = validateKey(input.idempotencyKey);
    if (!validKey.ok) return validKey;
    const inputFingerprint = fingerprint([
      "END",
      input.expeditionId,
      input.expectedRevision.toString(),
      input.reason,
    ]);
    return withTransaction(this.pool, async (client) => {
      const player = await lockedPlayer(client, input.playerId);
      if (!player.ok) return player;
      const prior = await replay(client, input.playerId, input.idempotencyKey, inputFingerprint);
      if (prior !== null) return prior;
      const original = await lockedExpedition(client, input.playerId, input.expeditionId);
      if (original === null) return unavailable();
      const transition = endExpedition({
        expedition: original,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
      if (!transition.ok) return transition;
      await persistSnapshot(client, transition.value.expedition, original.revision);
      return ok(
        await writeReceipt(
          client,
          input.playerId,
          input.idempotencyKey,
          input.expeditionId,
          "END",
          inputFingerprint,
          transition.value,
        ),
      );
    });
  }
}
