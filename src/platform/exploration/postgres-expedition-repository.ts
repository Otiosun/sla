import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ExpeditionPeriod } from "../../modules/exploration/expedition-clock.js";
import {
  advanceExpedition,
  changeExpeditionPeriod,
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
import { appError, err, ok, type AppError, type Result } from "../../shared-kernel/result.js";

/**
 * Staging-only V1.1 lifecycle persistence. It intentionally does not wire
 * WhatsApp, grant rewards, move a player or execute encounter/battle effects.
 * Its draft schema lives outside the immutable production migration chain.
 */
export interface StoredExpeditionTransition extends ExpeditionTransition {
  readonly replayed: boolean;
}

/** A durable gameplay-effect reference, committed in the SAME PG transaction. */
export interface StoredSearchActionTransition extends StoredExpeditionTransition {
  readonly effectRef: string;
}

/**
 * SEARCH_FREE remains staging-only. The trusted adapter must write encounter
 * effects using the provided client; network calls / independent DB pools are
 * forbidden because they cannot roll back with expedition quota and minutes.
 */
export interface ExecuteSearchActionInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
  readonly effect: (client: PoolClient, expedition: ExpeditionSnapshot) => Promise<
    Result<{ readonly effectRef: string }>
  >;
}

class AbortedSearchAction extends Error {
  public constructor(public readonly domainError: AppError) {
    super(domainError.message);
  }
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
  readonly effectRef?: string;
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

export interface ChangeStoredExpeditionPeriodInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly period: ExpeditionPeriod;
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

function serialize(value: ExpeditionTransition, effectRef?: string): string {
  return JSON.stringify({
    ...value,
    expedition: { ...value.expedition, revision: value.expedition.revision.toString() },
    ...(effectRef === undefined ? {} : { effectRef }),
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
  const player = await client.query<{ status: string; onboarding_complete: boolean }>(
    `SELECT player.status,
            EXISTS (
              SELECT 1 FROM onboarding_states onboarding
              WHERE onboarding.player_id = player.id AND onboarding.state = 'COMPLETE'
            ) AS onboarding_complete
     FROM players AS player
     WHERE player.id = $1 FOR UPDATE`,
    [playerId],
  );
  return player.rows[0]?.status === "ACTIVE" && player.rows[0]?.onboarding_complete === true
    ? ok(undefined)
    : err(appError("PLAYER_INELIGIBLE", "Only active trainers with completed onboarding may start or change an expedition"));
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
  operation: "PREPARE" | "ADVANCE" | "END" | "CHANGE_PERIOD" | "ACTION_SEARCH_FREE",
  inputFingerprint: string,
  transition: ExpeditionTransition,
  effectRef?: string,
): Promise<StoredExpeditionTransition> {
  await client.query(
    "INSERT INTO solo_expedition_receipts(player_id,idempotency_key,expedition_id,operation,fingerprint,result) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [playerId, key, expeditionId, operation, inputFingerprint, serialize(transition, effectRef)],
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
    "UPDATE solo_expeditions SET period=$3,phase=$4,elapsed_minutes=$5,consumed_week_key=$6::date,end_reason=$7,revision=$8::bigint,updated_at=now() WHERE id=$1 AND player_id=$2 AND revision=$9::bigint",
    [
      value.expeditionId,
      value.playerId,
      value.period,
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

      // The location must be part of the ACTIVE PUBLISHED content release,
      // not merely an identity row from a DRAFT or archived release.
      // If the active pointer or any region/area publication is missing,
      // fail closed before creating a PREPARING expedition or receipt.
      const location = await client.query<{ area_id: string }>(
        `SELECT area.id::text AS area_id
         FROM player_locations AS location
         JOIN areas AS area ON area.id = location.area_id
         JOIN regions AS region ON region.id = area.region_id
         JOIN content_release_pointers AS pointer ON pointer.pointer_key = 'ACTIVE'
         JOIN content_releases AS release
           ON release.id = pointer.content_release_id AND release.status = 'PUBLISHED'
         JOIN rulesets AS ruleset
           ON ruleset.id = release.default_ruleset_id AND ruleset.status = 'PUBLISHED'
         JOIN region_revisions AS region_rev
           ON region_rev.region_id = region.id
          AND region_rev.content_release_id = release.id AND region_rev.active = TRUE
         JOIN area_revisions AS area_rev
           ON area_rev.area_id = area.id
          AND area_rev.content_release_id = release.id AND area_rev.active = TRUE
         WHERE location.player_id = $1
           AND region.slug = 'zhoulia'
           AND area.slug IN ('vila-dos-arrozais', 'campos-de-yun')
         FOR UPDATE OF location`,
        [input.playerId],
      );
      const areaId = location.rows[0]?.area_id;
      if (areaId === undefined) {
        return err(appError("FLOW_BLOCKED", "A verified trainer location in the ACTIVE PUBLISHED content release is required"));
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

  /**
   * A real search-action commit seam: the encounter adapter must persist its
   * effect using this SAME PoolClient. If it refuses/throws, quota, minutes,
   * receipt and all its PG writes roll back together. This is not wired to a
   * WhatsApp command until a canonical Encounter adapter is available.
   */
  public async executeSearchFree(
    input: ExecuteSearchActionInput,
  ): Promise<Result<StoredSearchActionTransition>> {
    const validKey = validateKey(input.idempotencyKey);
    if (!validKey.ok) return validKey;
    const inputFingerprint = fingerprint([
      "ACTION_SEARCH_FREE",
      input.expeditionId,
      input.expectedRevision.toString(),
      30,
    ]);
    try {
      return await withTransaction(this.pool, async (client) => {
        const player = await lockedPlayer(client, input.playerId);
        if (!player.ok) return player;
        const prior = await client.query<ReceiptRow>(
          "SELECT fingerprint,result FROM solo_expedition_receipts WHERE player_id=$1 AND idempotency_key=$2",
          [input.playerId, input.idempotencyKey],
        );
        const old = prior.rows[0];
        if (old !== undefined) {
          if (old.fingerprint !== inputFingerprint) {
            return err(appError("IDEMPOTENCY_KEY_INVALID", "Expedition key reused for different action"));
          }
          if (typeof old.result.effectRef !== "string" ||
            old.result.effectRef.length === 0) {
            return err(appError("INVALID_STATE_TRANSITION", "Search receipt has no durable effect"));
          }
          return ok({
            ...restore(old.result, true),
            effectRef: old.result.effectRef,
          });
        }
        const original = await lockedExpedition(
          client, input.playerId, input.expeditionId,
        );
        if (original === null) return unavailable();

        // Recheck World location and the published launch scope under the
        // shared player lock, even after PREPARING was created.
        const location = await client.query<{ area_id: string }>(
          `SELECT area.id::text AS area_id
           FROM player_locations loc
           JOIN areas area ON area.id=loc.area_id
           JOIN regions region ON region.id=area.region_id
           JOIN content_release_pointers pointer ON pointer.pointer_key='ACTIVE'
           JOIN content_releases release ON release.id=pointer.content_release_id
             AND release.status='PUBLISHED'
           JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
             AND ruleset.status='PUBLISHED'
           JOIN region_revisions rr ON rr.region_id=region.id
             AND rr.content_release_id=release.id AND rr.active=TRUE
           JOIN area_revisions ar ON ar.area_id=area.id
             AND ar.content_release_id=release.id AND ar.active=TRUE
           WHERE loc.player_id=$1 AND region.slug='zhoulia'
             AND area.slug IN ('vila-dos-arrozais','campos-de-yun')
           FOR UPDATE OF loc`,
          [input.playerId],
        );
        if (location.rows[0]?.area_id !== original.areaId) {
          return err(appError("FLOW_BLOCKED", "Expedition World location or release changed"));
        }
        const week = expeditionWeekKey(this.clock.now(), this.timeZone);
        const used = await client.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key=$2::date",
          [input.playerId, week],
        );
        const transition = advanceExpedition({
          expedition: original,
          expectedRevision: input.expectedRevision,
          minutes: 30,
          weekKey: week,
          consumedThisWeek: Number(used.rows[0]?.count ?? "0"),
        });
        if (!transition.ok) return transition;

        // The effect runs before the clock/quota is persisted. Its SQL writes
        // participate in the same transaction and roll back on rejection.
        const effect = await input.effect(client, original);
        if (!effect.ok) throw new AbortedSearchAction(effect.error);
        const effectRef = effect.value.effectRef;
        if (typeof effectRef !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/u.test(effectRef)) {
          throw new AbortedSearchAction(
            appError("VALIDATION_FAILED", "Search effect must return a durable reference"),
          );
        }
        await persistSnapshot(client, transition.value.expedition, original.revision);
        const written = await writeReceipt(
          client, input.playerId, input.idempotencyKey, input.expeditionId,
          "ACTION_SEARCH_FREE", inputFingerprint, transition.value, effectRef,
        );
        return ok({ ...written, effectRef });
      });
    } catch (error) {
      if (error instanceof AbortedSearchAction) return err(error.domainError);
      throw error;
    }
  }

  /** Idempotent, revision-locked DAY/NIGHT toggle; never consumes a slot. */
  public async changePeriod(
    input: ChangeStoredExpeditionPeriodInput,
  ): Promise<Result<StoredExpeditionTransition>> {
    const validKey = validateKey(input.idempotencyKey);
    if (!validKey.ok) return validKey;
    if (input.period !== "DAY" && input.period !== "NIGHT") {
      return err(appError("VALIDATION_FAILED", "Unknown expedition period"));
    }
    const inputFingerprint = fingerprint([
      "CHANGE_PERIOD",
      input.expeditionId,
      input.expectedRevision.toString(),
      input.period,
    ]);
    return withTransaction(this.pool, async (client) => {
      const player = await lockedPlayer(client, input.playerId);
      if (!player.ok) return player;
      const prior = await replay(client, input.playerId, input.idempotencyKey, inputFingerprint);
      if (prior !== null) return prior;
      const original = await lockedExpedition(client, input.playerId, input.expeditionId);
      if (original === null) return unavailable();
      const transition = changeExpeditionPeriod({
        expedition: original,
        expectedRevision: input.expectedRevision,
        period: input.period,
      });
      if (!transition.ok) return transition;
      if (transition.value.changed) {
        await persistSnapshot(client, transition.value.expedition, original.revision);
      }
      return ok(await writeReceipt(
        client, input.playerId, input.idempotencyKey, input.expeditionId,
        "CHANGE_PERIOD", inputFingerprint, transition.value,
      ));
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
