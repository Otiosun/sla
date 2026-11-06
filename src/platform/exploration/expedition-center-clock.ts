import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";
import {
  advanceExpedition,
  type ExpeditionSnapshot,
} from "../../modules/exploration/expedition-state.js";
import { expeditionWeekKey } from "../../modules/exploration/expedition-week.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { Clock } from "../clock/index.js";

/** The Center owns the transaction and player lock. Clock, quota and healing commit together. */
export async function chargeExpeditionCenter(
  client: PoolClient,
  input: {
    readonly playerId: string;
    readonly inboxId: string;
    readonly clock: Clock;
    readonly timeZone: string;
  },
): Promise<Result<void>> {
  if (!expeditionOperationAllowed(input.playerId)) {
    throw new Error("Expedition Center integration requires isolated test runtime");
  }
  const found = await client.query<{
    id: string;
    period: "DAY" | "NIGHT";
    area_id: string;
    phase: "PREPARING" | "ACTIVE";
    elapsed_minutes: number;
    week: string | null;
    revision: string;
  }>(
    `SELECT id::text,period,area_id::text,phase,elapsed_minutes,consumed_week_key::text AS week,revision::text
     FROM solo_expeditions WHERE player_id=$1 AND phase IN ('PREPARING','ACTIVE') FOR UPDATE`,
    [input.playerId],
  );
  const row = found.rows[0];
  if (!row) return ok(undefined);
  const pending = await client.query(
    `SELECT 1 FROM encounters WHERE player_id=$1
    AND status IN ('CREATED','PRESENTED','ENGAGED','CAPTURE_RESOLVING','IN_BATTLE') LIMIT 1`,
    [input.playerId],
  );
  if (pending.rowCount !== 0)
    return err(appError("FLOW_BLOCKED", "Resolva o encontro antes de usar o Centro."));
  const week = expeditionWeekKey(input.clock.now(), input.timeZone);
  const used = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key=$2::date",
    [input.playerId, week],
  );
  const original: ExpeditionSnapshot = {
    expeditionId: row.id,
    playerId: input.playerId,
    period: row.period,
    areaId: row.area_id,
    phase: row.phase,
    elapsedMinutes: row.elapsed_minutes,
    consumedWeekKey: row.week,
    endReason: null,
    revision: BigInt(row.revision),
  };
  const next = advanceExpedition({
    expedition: original,
    expectedRevision: original.revision,
    minutes: 30,
    weekKey: week,
    consumedThisWeek: Number(used.rows[0]?.n ?? "0"),
  });
  if (!next.ok) return next;
  const state = next.value.expedition;
  const updated = await client.query(
    `UPDATE solo_expeditions SET phase=$2,elapsed_minutes=$3,consumed_week_key=$4::date,
    end_reason=$5,revision=$6::bigint,updated_at=now() WHERE id=$1 AND revision=$7::bigint`,
    [
      row.id,
      state.phase,
      state.elapsedMinutes,
      state.consumedWeekKey,
      state.endReason,
      state.revision.toString(),
      row.revision,
    ],
  );
  if (updated.rowCount !== 1) throw new Error("Center clock lost the locked expedition revision");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(["ADVANCE", row.id, row.revision, 30]))
    .digest("hex");
  await client.query(
    `INSERT INTO solo_expedition_receipts(player_id,idempotency_key,expedition_id,operation,fingerprint,result)
    VALUES($1,$2,$3,'ADVANCE',$4,$5::jsonb)`,
    [
      input.playerId,
      "center:" + input.inboxId,
      row.id,
      fingerprint,
      JSON.stringify({
        ...next.value,
        expedition: { ...state, revision: state.revision.toString() },
        service: "POKEMON_CENTER",
      }),
    ],
  );
  return ok(undefined);
}
