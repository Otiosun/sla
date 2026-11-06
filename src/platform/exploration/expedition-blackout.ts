import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";

/** Settle an expedition battle in the turn or durable defeat transaction. */
export async function settleExpeditionBattle(
  client: PoolClient,
  playerId: string,
  battleId: string,
  defeated: boolean,
  operationalPlayers?: ReadonlySet<string>,
): Promise<boolean> {
  await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
  if (operationalPlayers !== undefined) {
    if (!operationalPlayers.has(playerId)) return false;
    const active = await client.query(
      "SELECT 1 FROM player_access WHERE player_id=$1 AND status='ACTIVE' FOR SHARE",
      [playerId],
    );
    if (active.rowCount !== 1) return false;
  } else if (!expeditionOperationAllowed(playerId)) {
    throw new Error("Expedition battle settlement requires an authorized runtime");
  }
  const team = defeated
    ? await client.query<{ total: number; able: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE pokemon.current_hp>0)::int AS able
     FROM pokemon_roster_slots roster JOIN pokemon_instances pokemon
       ON pokemon.id=roster.pokemon_instance_id AND pokemon.owner_player_id=roster.player_id
     WHERE roster.player_id=$1 AND roster.placement_kind='TEAM'`,
        [playerId],
      )
    : null;
  const roster = team?.rows[0];
  const blackout = roster !== undefined && roster.total > 0 && roster.able === 0;
  const key = (blackout ? "battle-blackout:" : "battle-settlement:") + battleId;
  const found = await client.query<{ id: string; revision: string }>(
    `SELECT expedition.id::text, expedition.revision::text FROM solo_expeditions expedition
     WHERE expedition.player_id=$1 AND (expedition.phase='ACTIVE' OR
       ($3 AND expedition.phase='ENDED' AND expedition.end_reason='CLOCK'))
       AND EXISTS (SELECT 1 FROM battles battle WHERE battle.id=$2::uuid AND (
         EXISTS (SELECT 1 FROM solo_expedition_search_outcomes outcome
           WHERE outcome.expedition_id=expedition.id AND outcome.player_id=expedition.player_id
             AND outcome.encounter_id=battle.encounter_id)
         OR EXISTS (SELECT 1 FROM solo_expedition_fishing_encounters fishing
           WHERE fishing.expedition_id=expedition.id AND fishing.player_id=expedition.player_id
             AND fishing.encounter_id=battle.encounter_id)))
       AND NOT EXISTS (SELECT 1 FROM solo_expedition_receipts receipt
         WHERE receipt.player_id=$1 AND receipt.idempotency_key IN ('battle-blackout:' || $2::text,'battle-settlement:' || $2::text))
     FOR UPDATE OF expedition`,
    [playerId, battleId, blackout],
  );
  const expedition = found.rows[0];
  if (!expedition) return false;
  const changed = await client.query<{
    period: string;
    area_id: string;
    elapsed_minutes: number;
    week: string;
    revision: string;
    phase: string;
    end_reason: string | null;
  }>(
    `UPDATE solo_expeditions SET phase=CASE WHEN $3 OR elapsed_minutes+30>=720 THEN 'ENDED' ELSE 'ACTIVE' END,
       end_reason=CASE WHEN $3 THEN 'BLACKOUT' WHEN elapsed_minutes+30>=720 THEN 'CLOCK' ELSE NULL END,
       elapsed_minutes=LEAST(720,elapsed_minutes+30),revision=revision+1,updated_at=now()
     WHERE id=$1 AND revision=$2::bigint
     RETURNING period,area_id::text,elapsed_minutes,consumed_week_key::text AS week,revision::text,phase,end_reason`,
    [expedition.id, expedition.revision, blackout],
  );
  const row = changed.rows[0];
  if (!row) throw new Error("Battle settlement lost the locked expedition revision");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([key, expedition.id, expedition.revision]))
    .digest("hex");
  await client.query(
    `INSERT INTO solo_expedition_receipts(player_id,idempotency_key,expedition_id,operation,fingerprint,result)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      playerId,
      key,
      expedition.id,
      blackout ? "END" : "ADVANCE",
      fingerprint,
      JSON.stringify({
        expedition: {
          expeditionId: expedition.id,
          playerId,
          period: row.period,
          areaId: row.area_id,
          phase: row.phase,
          elapsedMinutes: row.elapsed_minutes,
          consumedWeekKey: row.week,
          endReason: row.end_reason,
          revision: row.revision,
        },
        consumedWeeklySlot: false,
        changed: true,
      }),
    ],
  );
  return blackout;
}
