import type { Pool } from "pg";
import type {
  OperationalInventoryItemView,
  OperationalPokedexSpeciesView,
  OperationalRegionOption,
  OperationalTeamMemberView,
  OperationalUxReadModel,
} from "../../modules/messaging/operational-ux-read-model.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { parsePokemonInstanceId } from "../../shared-kernel/ids.js";

export class PostgresOperationalUxReadModel implements OperationalUxReadModel {
  public constructor(private readonly pool: Pool) {}

  public async listRegionOptions(playerId: PlayerId): Promise<readonly OperationalRegionOption[]> {
    const result = await this.pool.query<{ region_id: string; display_name: string }>(
      `SELECT revision.region_id, revision.display_name
       FROM player_onboarding_context context
       JOIN region_revisions revision
         ON revision.content_release_id = context.content_release_id
        AND revision.active = TRUE
       WHERE context.player_id = $1
       ORDER BY revision.display_name, revision.region_id`,
      [playerId],
    );
    return result.rows.map((row) => ({ regionId: row.region_id, displayName: row.display_name }));
  }

  public async listTeam(playerId: PlayerId): Promise<readonly OperationalTeamMemberView[]> {
    const result = await this.pool.query<{
      pokemon_instance_id: string;
      display_name: string;
      level: number;
      current_hp: number;
      slot_no: number;
    }>(
      `SELECT pokemon.id AS pokemon_instance_id,
              species_revision.display_name,
              pokemon.level,
              pokemon.current_hp,
              roster.slot_no
       FROM pokemon_roster_slots roster
       JOIN pokemon_instances pokemon ON pokemon.id = roster.pokemon_instance_id
       JOIN pokemon_forms form_identity ON form_identity.id = pokemon.form_id
       JOIN player_onboarding_context context ON context.player_id = roster.player_id
       JOIN pokemon_species_revisions species_revision
         ON species_revision.content_release_id = context.content_release_id
        AND species_revision.species_id = form_identity.species_id
        AND species_revision.active = TRUE
       WHERE roster.player_id = $1
         AND roster.placement_kind = 'TEAM'
         AND pokemon.status = 'ACTIVE'
       ORDER BY roster.slot_no`,
      [playerId],
    );
    return result.rows.map((row) => {
      const parsed = parsePokemonInstanceId(row.pokemon_instance_id);
      if (!parsed.ok)
        throw new Error("Operational team projection returned invalid PokemonInstanceId");
      return {
        pokemonInstanceId: parsed.value,
        displayName: row.display_name,
        level: row.level,
        currentHp: row.current_hp,
        slotNo: row.slot_no,
      };
    });
  }

  public async listInventory(playerId: PlayerId): Promise<readonly OperationalInventoryItemView[]> {
    const result = await this.pool.query<{
      item_id: string;
      item_slug: string;
      display_name: string;
      quantity: string;
    }>(
      `SELECT balance.item_id,
              identity.slug AS item_slug,
              revision.display_name,
              balance.quantity::text
       FROM inventory_balances balance
       JOIN items identity ON identity.id = balance.item_id
       JOIN player_onboarding_context context ON context.player_id = balance.player_id
       JOIN item_revisions revision
         ON revision.content_release_id = context.content_release_id
        AND revision.item_id = balance.item_id
        AND revision.active = TRUE
       WHERE balance.player_id = $1 AND balance.quantity > 0
       ORDER BY revision.display_name, balance.item_id`,
      [playerId],
    );
    return result.rows.map((row) => ({
      itemId: row.item_id,
      itemSlug: row.item_slug,
      displayName: row.display_name,
      quantity: BigInt(row.quantity),
    }));
  }

  public async listPokedex(playerId: PlayerId): Promise<readonly OperationalPokedexSpeciesView[]> {
    const result = await this.pool.query<{
      species_id: string;
      national_dex: number;
      species_slug: string;
      display_name: string;
      seen_count: string;
      caught_count: string;
    }>(
      `SELECT dex.species_id,
              identity.national_dex,
              identity.slug AS species_slug,
              revision.display_name,
              dex.seen_count::text,
              dex.caught_count::text
       FROM player_pokedex_species dex
       JOIN pokemon_species identity ON identity.id = dex.species_id
       JOIN player_onboarding_context context ON context.player_id = dex.player_id
       JOIN pokemon_species_revisions revision
         ON revision.content_release_id = context.content_release_id
        AND revision.species_id = dex.species_id
        AND revision.active = TRUE
       WHERE dex.player_id = $1 AND dex.seen_count > 0
       ORDER BY identity.national_dex, dex.species_id`,
      [playerId],
    );
    return result.rows.map((row) => ({
      speciesId: row.species_id,
      nationalDex: row.national_dex,
      speciesSlug: row.species_slug,
      displayName: row.display_name,
      seenCount: BigInt(row.seen_count),
      caughtCount: BigInt(row.caught_count),
    }));
  }

  public async activeBattleId(playerId: PlayerId): Promise<string | null> {
    const result = await this.pool.query<{ battle_id: string }>(
      `SELECT battle.id AS battle_id
       FROM battle_sides side
       JOIN battles battle ON battle.id = side.battle_id
       WHERE side.player_id = $1
         AND battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
       ORDER BY battle.created_at DESC, battle.id DESC
       LIMIT 1`,
      [playerId],
    );
    return result.rows[0]?.battle_id ?? null;
  }

  public async speciesDisplayName(
    contentReleaseId: string,
    speciesId: string,
  ): Promise<string | null> {
    const result = await this.pool.query<{ display_name: string }>(
      `SELECT display_name
       FROM pokemon_species_revisions
       WHERE content_release_id = $1 AND species_id = $2 AND active = TRUE`,
      [contentReleaseId, speciesId],
    );
    return result.rows[0]?.display_name ?? null;
  }

  public async moveDisplayNames(
    contentReleaseId: string,
    moveIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (moveIds.length === 0) return new Map();
    const result = await this.pool.query<{ move_id: string; display_name: string }>(
      `SELECT move_id, display_name
       FROM move_revisions
       WHERE content_release_id = $1
         AND move_id = ANY($2::uuid[])
         AND active = TRUE`,
      [contentReleaseId, [...new Set(moveIds)]],
    );
    return new Map(result.rows.map((row) => [row.move_id, row.display_name] as const));
  }
}
