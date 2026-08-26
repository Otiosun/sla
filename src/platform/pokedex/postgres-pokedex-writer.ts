import type { PoolClient } from "pg";

export async function recordPokedexSeen(
  client: PoolClient,
  playerId: string,
  speciesId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO player_pokedex_species(
       player_id, species_id, seen_count, caught_count,
       first_seen_at, last_seen_at, first_caught_at, last_caught_at
     ) VALUES ($1, $2, 1, 0, now(), now(), NULL, NULL)
     ON CONFLICT (player_id, species_id)
     DO UPDATE SET seen_count = player_pokedex_species.seen_count + 1,
                   first_seen_at = COALESCE(player_pokedex_species.first_seen_at, now()),
                   last_seen_at = now(),
                   revision = player_pokedex_species.revision + 1`,
    [playerId, speciesId],
  );
}

export async function recordPokedexCaught(
  client: PoolClient,
  playerId: string,
  speciesId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO player_pokedex_species(
       player_id, species_id, seen_count, caught_count,
       first_seen_at, last_seen_at, first_caught_at, last_caught_at
     ) VALUES ($1, $2, 1, 1, now(), now(), now(), now())
     ON CONFLICT (player_id, species_id)
     DO UPDATE SET seen_count = player_pokedex_species.seen_count + 1,
                   caught_count = player_pokedex_species.caught_count + 1,
                   first_seen_at = COALESCE(player_pokedex_species.first_seen_at, now()),
                   last_seen_at = now(),
                   first_caught_at = COALESCE(player_pokedex_species.first_caught_at, now()),
                   last_caught_at = now(),
                   revision = player_pokedex_species.revision + 1`,
    [playerId, speciesId],
  );
}

export async function recordPokedexOwned(
  client: PoolClient,
  playerId: string,
  speciesId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO player_pokedex_species(
       player_id, species_id, seen_count, caught_count,
       first_seen_at, last_seen_at, first_caught_at, last_caught_at
     ) VALUES ($1, $2, 1, 1, now(), now(), now(), now())
     ON CONFLICT (player_id, species_id)
     DO UPDATE SET seen_count = GREATEST(player_pokedex_species.seen_count, 1),
                   caught_count = GREATEST(player_pokedex_species.caught_count, 1),
                   first_seen_at = COALESCE(player_pokedex_species.first_seen_at, now()),
                   last_seen_at = COALESCE(player_pokedex_species.last_seen_at, now()),
                   first_caught_at = COALESCE(player_pokedex_species.first_caught_at, now()),
                   last_caught_at = COALESCE(player_pokedex_species.last_caught_at, now()),
                   revision = player_pokedex_species.revision + 1`,
    [playerId, speciesId],
  );
}

export async function recordPokedexOwnedByForm(
  client: PoolClient,
  playerId: string,
  formId: string,
): Promise<void> {
  const species = await client.query<{ species_id: string }>(
    "SELECT species_id FROM pokemon_forms WHERE id = $1",
    [formId],
  );
  const speciesId = species.rows[0]?.species_id;
  if (speciesId === undefined) throw new Error("Pokédex ownership form has no species identity");
  await recordPokedexOwned(client, playerId, speciesId);
}
