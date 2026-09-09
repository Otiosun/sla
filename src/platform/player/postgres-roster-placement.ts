import type { PoolClient } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";

export interface CanonicalRosterPlacement {
  readonly placementKind: "TEAM" | "BOX";
  readonly boxNo: number | null;
  readonly slotNo: number;
}

export interface CanonicalBoxPlacement {
  readonly placementKind: "BOX";
  readonly boxNo: number;
  readonly slotNo: number;
}

const TEAM_CAPACITY = 6;
const BOX_CAPACITY = 30;

async function lockRosterPlayer(client: PoolClient, playerId: PlayerId): Promise<void> {
  const locked = await client.query<{ id: string }>(
    "SELECT id::text FROM players WHERE id = $1 FOR UPDATE",
    [playerId],
  );
  if (locked.rows[0] === undefined) {
    throw new Error("Roster placement player does not exist");
  }
}

async function firstAvailableBoxPlacement(
  client: PoolClient,
  playerId: PlayerId,
): Promise<CanonicalBoxPlacement> {
  const box = await client.query<{ box_no: number; slot_no: number }>(
    `WITH bounds AS (
       SELECT COALESCE(MAX(box_no), 0) + 1 AS max_box
       FROM pokemon_roster_slots
       WHERE player_id = $1 AND placement_kind = 'BOX'
     ), candidates AS (
       SELECT box_no, slot_no
       FROM bounds
       CROSS JOIN LATERAL generate_series(1, bounds.max_box) AS box_no
       CROSS JOIN LATERAL generate_series(1, $2::integer) AS slot_no
     )
     SELECT candidate.box_no, candidate.slot_no
     FROM candidates candidate
     WHERE NOT EXISTS (
       SELECT 1
       FROM pokemon_roster_slots occupied
       WHERE occupied.player_id = $1
         AND occupied.placement_kind = 'BOX'
         AND occupied.box_no = candidate.box_no
         AND occupied.slot_no = candidate.slot_no
     )
     ORDER BY candidate.box_no, candidate.slot_no
     LIMIT 1`,
    [playerId, BOX_CAPACITY],
  );
  const next = box.rows[0];
  if (next === undefined) {
    throw new Error("Roster placement could not find an available Box slot");
  }
  return { placementKind: "BOX", boxNo: next.box_no, slotNo: next.slot_no };
}

export async function nextPokemonBoxPlacement(
  client: PoolClient,
  playerId: PlayerId,
): Promise<CanonicalBoxPlacement> {
  await lockRosterPlayer(client, playerId);
  return firstAvailableBoxPlacement(client, playerId);
}

export async function nextCanonicalRosterPlacement(
  client: PoolClient,
  playerId: PlayerId,
): Promise<CanonicalRosterPlacement> {
  await lockRosterPlayer(client, playerId);

  const team = await client.query<{ slot_no: number }>(
    `SELECT slot_no
     FROM pokemon_roster_slots
     WHERE player_id = $1 AND placement_kind = 'TEAM'
     ORDER BY slot_no`,
    [playerId],
  );
  const occupiedTeam = new Set(team.rows.map((row) => row.slot_no));
  for (let slot = 1; slot <= TEAM_CAPACITY; slot += 1) {
    if (!occupiedTeam.has(slot)) {
      return { placementKind: "TEAM", boxNo: null, slotNo: slot };
    }
  }

  return firstAvailableBoxPlacement(client, playerId);
}
