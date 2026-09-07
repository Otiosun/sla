import type { Pool, PoolClient } from "pg";
import type {
  DepositPokemonPcInput,
  OrganizePokemonPcInput,
  PokemonPcBoxView,
  PokemonPcDepositPersistenceResult,
  PokemonPcOrganizePersistenceResult,
  PokemonPcPokemonView,
  PokemonPcStorageRepository,
  PokemonPcStorageSnapshot,
  PokemonPcWithdrawPersistenceResult,
  WithdrawPokemonPcInput,
} from "../../modules/world-services/pc-storage-service.js";
import {
  type PlayerId,
  type PokemonInstanceId,
  parsePokemonInstanceId,
} from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";
import { nextPokemonBoxPlacement } from "../player/postgres-roster-placement.js";

const TEAM_CAPACITY = 6;
const BOX_CAPACITY = 30 as const;

function pokemonId(value: string): PokemonInstanceId {
  const parsed = parsePokemonInstanceId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PokemonInstanceId");
  return parsed.value;
}

async function lockPlayer(client: PoolClient, playerId: PlayerId): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    "SELECT id::text FROM players WHERE id = $1 FOR UPDATE",
    [playerId],
  );
  return result.rows[0] !== undefined;
}

async function firstFreeTeamSlot(client: PoolClient, playerId: PlayerId): Promise<number | null> {
  const team = await client.query<{ slot_no: number }>(
    `SELECT slot_no
     FROM pokemon_roster_slots
     WHERE player_id = $1 AND placement_kind = 'TEAM'
     ORDER BY slot_no`,
    [playerId],
  );
  const occupied = new Set(team.rows.map((row) => row.slot_no));
  for (let slot = 1; slot <= TEAM_CAPACITY; slot += 1) {
    if (!occupied.has(slot)) return slot;
  }
  return null;
}

export class PostgresPokemonPcStorageRepository implements PokemonPcStorageRepository {
  public constructor(private readonly pool: Pool) {}

  public async loadStorage(playerId: PlayerId): Promise<PokemonPcStorageSnapshot> {
    const rows = await this.pool.query<{
      pokemon_instance_id: string;
      display_name: string;
      level: number;
      placement_kind: "TEAM" | "BOX";
      box_no: number | null;
      slot_no: number;
    }>(
      `SELECT pokemon.id::text AS pokemon_instance_id,
              species_revision.display_name,
              pokemon.level,
              roster.placement_kind,
              roster.box_no,
              roster.slot_no
       FROM pokemon_roster_slots roster
       JOIN pokemon_instances pokemon ON pokemon.id = roster.pokemon_instance_id
       JOIN pokemon_forms form ON form.id = pokemon.form_id
       JOIN player_onboarding_context context ON context.player_id = roster.player_id
       JOIN pokemon_species_revisions species_revision
         ON species_revision.content_release_id = context.content_release_id
        AND species_revision.species_id = form.species_id
        AND species_revision.active = TRUE
       WHERE roster.player_id = $1
       ORDER BY CASE roster.placement_kind WHEN 'TEAM' THEN 0 ELSE 1 END,
                roster.box_no NULLS FIRST,
                roster.slot_no,
                pokemon.id`,
      [playerId],
    );

    const team: PokemonPcPokemonView[] = [];
    const boxes = new Map<number, PokemonPcPokemonView[]>();
    for (const row of rows.rows) {
      const view: PokemonPcPokemonView = {
        pokemonInstanceId: pokemonId(row.pokemon_instance_id),
        displayName: row.display_name,
        level: row.level,
        placementKind: row.placement_kind,
        boxNo: row.box_no,
        slotNo: row.slot_no,
      };
      if (row.placement_kind === "TEAM") {
        team.push(view);
        continue;
      }
      if (row.box_no === null) throw new Error("BOX roster row is missing box_no");
      const members = boxes.get(row.box_no) ?? [];
      members.push(view);
      boxes.set(row.box_no, members);
    }

    const boxViews: PokemonPcBoxView[] = [...boxes.entries()]
      .sort(([left], [right]) => left - right)
      .map(([boxNo, pokemon]) => ({
        boxNo,
        occupied: pokemon.length,
        capacity: BOX_CAPACITY,
        pokemon,
      }));

    return { playerId, team, boxes: boxViews };
  }

  public async deposit(
    input: DepositPokemonPcInput,
  ): Promise<PokemonPcDepositPersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      if (!(await lockPlayer(client, input.playerId))) return { kind: "POKEMON_NOT_IN_TEAM" };

      const target = await client.query<{ slot_no: number }>(
        `SELECT slot_no
         FROM pokemon_roster_slots
         WHERE player_id = $1 AND pokemon_instance_id = $2 AND placement_kind = 'TEAM'
         FOR UPDATE`,
        [input.playerId, input.pokemonInstanceId],
      );
      const targetRow = target.rows[0];
      if (targetRow === undefined) return { kind: "POKEMON_NOT_IN_TEAM" };

      const team = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pokemon_roster_slots
         WHERE player_id = $1 AND placement_kind = 'TEAM'`,
        [input.playerId],
      );
      if (Number(team.rows[0]?.count ?? "0") <= 1) return { kind: "LAST_TEAM_MEMBER" };

      const placement = await nextPokemonBoxPlacement(client, input.playerId);
      const updated = await client.query(
        `UPDATE pokemon_roster_slots
         SET placement_kind = 'BOX', box_no = $3, slot_no = $4
         WHERE player_id = $1 AND pokemon_instance_id = $2 AND placement_kind = 'TEAM'`,
        [input.playerId, input.pokemonInstanceId, placement.boxNo, placement.slotNo],
      );
      if (updated.rowCount !== 1) return { kind: "POKEMON_NOT_IN_TEAM" };

      return {
        kind: "APPLIED",
        pokemonInstanceId: input.pokemonInstanceId,
        fromSlotNo: targetRow.slot_no,
        boxNo: placement.boxNo,
        slotNo: placement.slotNo,
      };
    });
  }

  public async withdraw(
    input: WithdrawPokemonPcInput,
  ): Promise<PokemonPcWithdrawPersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      if (!(await lockPlayer(client, input.playerId))) return { kind: "POKEMON_NOT_IN_BOX" };

      const target = await client.query<{ box_no: number; slot_no: number }>(
        `SELECT box_no, slot_no
         FROM pokemon_roster_slots
         WHERE player_id = $1 AND pokemon_instance_id = $2 AND placement_kind = 'BOX'
         FOR UPDATE`,
        [input.playerId, input.pokemonInstanceId],
      );
      const targetRow = target.rows[0];
      if (targetRow === undefined) return { kind: "POKEMON_NOT_IN_BOX" };

      const teamSlotNo = await firstFreeTeamSlot(client, input.playerId);
      if (teamSlotNo === null) return { kind: "TEAM_FULL" };

      const updated = await client.query(
        `UPDATE pokemon_roster_slots
         SET placement_kind = 'TEAM', box_no = NULL, slot_no = $3
         WHERE player_id = $1 AND pokemon_instance_id = $2 AND placement_kind = 'BOX'`,
        [input.playerId, input.pokemonInstanceId, teamSlotNo],
      );
      if (updated.rowCount !== 1) return { kind: "POKEMON_NOT_IN_BOX" };

      return {
        kind: "APPLIED",
        pokemonInstanceId: input.pokemonInstanceId,
        fromBoxNo: targetRow.box_no,
        fromSlotNo: targetRow.slot_no,
        teamSlotNo,
      };
    });
  }

  public async organize(
    input: OrganizePokemonPcInput,
  ): Promise<PokemonPcOrganizePersistenceResult> {
    if (
      !Number.isInteger(input.boxNo) ||
      input.boxNo < 1 ||
      !Number.isInteger(input.slotNo) ||
      input.slotNo < 1 ||
      input.slotNo > BOX_CAPACITY
    ) {
      return { kind: "INVALID_DESTINATION" };
    }

    return withTransaction(this.pool, async (client) => {
      if (!(await lockPlayer(client, input.playerId))) return { kind: "POKEMON_NOT_IN_BOX" };

      const target = await client.query<{ box_no: number; slot_no: number }>(
        `SELECT box_no, slot_no
         FROM pokemon_roster_slots
         WHERE player_id = $1 AND pokemon_instance_id = $2 AND placement_kind = 'BOX'
         FOR UPDATE`,
        [input.playerId, input.pokemonInstanceId],
      );
      const targetRow = target.rows[0];
      if (targetRow === undefined) return { kind: "POKEMON_NOT_IN_BOX" };

      const occupied = await client.query<{ pokemon_instance_id: string }>(
        `SELECT pokemon_instance_id::text
         FROM pokemon_roster_slots
         WHERE player_id = $1
           AND placement_kind = 'BOX'
           AND box_no = $2
           AND slot_no = $3
           AND pokemon_instance_id <> $4
         LIMIT 1`,
        [input.playerId, input.boxNo, input.slotNo, input.pokemonInstanceId],
      );
      if (occupied.rows[0] !== undefined) return { kind: "DESTINATION_OCCUPIED" };

      const updated = await client.query(
        `UPDATE pokemon_roster_slots
         SET box_no = $3, slot_no = $4
         WHERE player_id = $1 AND pokemon_instance_id = $2 AND placement_kind = 'BOX'`,
        [input.playerId, input.pokemonInstanceId, input.boxNo, input.slotNo],
      );
      if (updated.rowCount !== 1) return { kind: "POKEMON_NOT_IN_BOX" };

      return {
        kind: "APPLIED",
        pokemonInstanceId: input.pokemonInstanceId,
        fromBoxNo: targetRow.box_no,
        fromSlotNo: targetRow.slot_no,
        toBoxNo: input.boxNo,
        toSlotNo: input.slotNo,
      };
    });
  }
}
