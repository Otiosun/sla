import type { Pool } from "pg";
import type {
  PokedexAdminSeenGrantResult,
  PokedexAdminSeenOwner,
} from "../../modules/pokedex/admin-seen-owner.js";
import { withTransaction } from "../db/transaction.js";

interface PokedexRow {
  readonly seen_count: string;
  readonly shiny_seen_count: string;
  readonly revision: string;
}

function empty(): PokedexRow {
  return { seen_count: "0", shiny_seen_count: "0", revision: "0" };
}

export class PostgresPokedexAdminSeenOwner implements PokedexAdminSeenOwner {
  public constructor(private readonly pool: Pool) {}

  public async grantSeen(input: {
    readonly playerId: string;
    readonly speciesId: string;
    readonly shiny: boolean;
  }): Promise<PokedexAdminSeenGrantResult | null> {
    return withTransaction(
      this.pool,
      async (client) => {
        const target = await client.query<{ player_exists: boolean; species_exists: boolean }>(
          `SELECT
             EXISTS(SELECT 1 FROM players WHERE id = $1) AS player_exists,
             EXISTS(SELECT 1 FROM pokemon_species WHERE id = $2) AS species_exists`,
          [input.playerId, input.speciesId],
        );
        const targetRow = target.rows[0];
        if (targetRow?.player_exists !== true || targetRow.species_exists !== true) return null;

        const beforeResult = await client.query<PokedexRow>(
          `SELECT seen_count::text, shiny_seen_count::text, revision::text
           FROM player_pokedex_species
           WHERE player_id = $1 AND species_id = $2
           FOR UPDATE`,
          [input.playerId, input.speciesId],
        );
        const before = beforeResult.rows[0] ?? empty();

        await client.query(
          `INSERT INTO player_pokedex_species(
             player_id, species_id, seen_count, caught_count,
             first_seen_at, last_seen_at, first_caught_at, last_caught_at,
             shiny_seen_count, shiny_caught_count,
             first_shiny_seen_at, last_shiny_seen_at,
             first_shiny_caught_at, last_shiny_caught_at
           ) VALUES (
             $1, $2, 1, 0,
             now(), now(), NULL, NULL,
             CASE WHEN $3::boolean THEN 1 ELSE 0 END,
             0,
             CASE WHEN $3::boolean THEN now() ELSE NULL END,
             CASE WHEN $3::boolean THEN now() ELSE NULL END,
             NULL,
             NULL
           )
           ON CONFLICT (player_id, species_id)
           DO UPDATE SET
             seen_count = GREATEST(player_pokedex_species.seen_count, 1),
             first_seen_at = COALESCE(player_pokedex_species.first_seen_at, now()),
             last_seen_at = COALESCE(player_pokedex_species.last_seen_at, now()),
             shiny_seen_count = CASE
               WHEN $3::boolean THEN GREATEST(player_pokedex_species.shiny_seen_count, 1)
               ELSE player_pokedex_species.shiny_seen_count
             END,
             first_shiny_seen_at = CASE
               WHEN $3::boolean
                 THEN COALESCE(player_pokedex_species.first_shiny_seen_at, now())
               ELSE player_pokedex_species.first_shiny_seen_at
             END,
             last_shiny_seen_at = CASE
               WHEN $3::boolean
                 THEN COALESCE(player_pokedex_species.last_shiny_seen_at, now())
               ELSE player_pokedex_species.last_shiny_seen_at
             END,
             revision = player_pokedex_species.revision + CASE
               WHEN player_pokedex_species.seen_count < 1
                 OR ($3::boolean AND player_pokedex_species.shiny_seen_count < 1)
               THEN 1
               ELSE 0
             END`,
          [input.playerId, input.speciesId, input.shiny],
        );

        const afterResult = await client.query<PokedexRow>(
          `SELECT seen_count::text, shiny_seen_count::text, revision::text
           FROM player_pokedex_species
           WHERE player_id = $1 AND species_id = $2`,
          [input.playerId, input.speciesId],
        );
        const after = afterResult.rows[0];
        if (after === undefined) throw new Error("Pokédex seen grant did not persist");

        return {
          beforeSeenCount: before.seen_count,
          afterSeenCount: after.seen_count,
          beforeShinySeenCount: before.shiny_seen_count,
          afterShinySeenCount: after.shiny_seen_count,
          beforeRevision: before.revision,
          afterRevision: after.revision,
          changed:
            before.seen_count !== after.seen_count ||
            before.shiny_seen_count !== after.shiny_seen_count,
        };
      },
      { isolationLevel: "READ COMMITTED" },
    );
  }
}
