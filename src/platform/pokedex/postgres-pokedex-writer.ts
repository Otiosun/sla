import type { PoolClient } from "pg";

export async function recordPokedexSeen(
  client: PoolClient,
  playerId: string,
  speciesId: string,
  shiny = false,
): Promise<void> {
  await client.query(
    `INSERT INTO player_pokedex_species(
       player_id, species_id, seen_count, caught_count,
       first_seen_at, last_seen_at, first_caught_at, last_caught_at,
       shiny_seen_count, shiny_caught_count,
       first_shiny_seen_at, last_shiny_seen_at,
       first_shiny_caught_at, last_shiny_caught_at
     ) VALUES (
       $1, $2, 1, 0, now(), now(), NULL, NULL,
       CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       0,
       CASE WHEN $3::boolean THEN now() ELSE NULL END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END,
       NULL,
       NULL
     )
     ON CONFLICT (player_id, species_id)
     DO UPDATE SET
       seen_count = player_pokedex_species.seen_count + 1,
       first_seen_at = COALESCE(player_pokedex_species.first_seen_at, now()),
       last_seen_at = now(),
       shiny_seen_count = player_pokedex_species.shiny_seen_count
         + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       first_shiny_seen_at = CASE
         WHEN $3::boolean
           THEN COALESCE(player_pokedex_species.first_shiny_seen_at, now())
         ELSE player_pokedex_species.first_shiny_seen_at
       END,
       last_shiny_seen_at = CASE
         WHEN $3::boolean THEN now()
         ELSE player_pokedex_species.last_shiny_seen_at
       END,
       revision = player_pokedex_species.revision + 1`,
    [playerId, speciesId, shiny],
  );
}

export async function recordPokedexCaught(
  client: PoolClient,
  playerId: string,
  speciesId: string,
  shiny = false,
): Promise<void> {
  await client.query(
    `INSERT INTO player_pokedex_species(
       player_id, species_id, seen_count, caught_count,
       first_seen_at, last_seen_at, first_caught_at, last_caught_at,
       shiny_seen_count, shiny_caught_count,
       first_shiny_seen_at, last_shiny_seen_at,
       first_shiny_caught_at, last_shiny_caught_at
     ) VALUES (
       $1, $2, 1, 1, now(), now(), now(), now(),
       CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END
     )
     ON CONFLICT (player_id, species_id)
     DO UPDATE SET
       seen_count = player_pokedex_species.seen_count + 1,
       caught_count = player_pokedex_species.caught_count + 1,
       first_seen_at = COALESCE(player_pokedex_species.first_seen_at, now()),
       last_seen_at = now(),
       first_caught_at = COALESCE(player_pokedex_species.first_caught_at, now()),
       last_caught_at = now(),
       shiny_seen_count = player_pokedex_species.shiny_seen_count
         + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       shiny_caught_count = player_pokedex_species.shiny_caught_count
         + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       first_shiny_seen_at = CASE
         WHEN $3::boolean
           THEN COALESCE(player_pokedex_species.first_shiny_seen_at, now())
         ELSE player_pokedex_species.first_shiny_seen_at
       END,
       last_shiny_seen_at = CASE
         WHEN $3::boolean THEN now()
         ELSE player_pokedex_species.last_shiny_seen_at
       END,
       first_shiny_caught_at = CASE
         WHEN $3::boolean
           THEN COALESCE(player_pokedex_species.first_shiny_caught_at, now())
         ELSE player_pokedex_species.first_shiny_caught_at
       END,
       last_shiny_caught_at = CASE
         WHEN $3::boolean THEN now()
         ELSE player_pokedex_species.last_shiny_caught_at
       END,
       revision = player_pokedex_species.revision + 1`,
    [playerId, speciesId, shiny],
  );
}

export async function recordPokedexOwned(
  client: PoolClient,
  playerId: string,
  speciesId: string,
  shiny = false,
): Promise<void> {
  await client.query(
    `INSERT INTO player_pokedex_species(
       player_id, species_id, seen_count, caught_count,
       first_seen_at, last_seen_at, first_caught_at, last_caught_at,
       shiny_seen_count, shiny_caught_count,
       first_shiny_seen_at, last_shiny_seen_at,
       first_shiny_caught_at, last_shiny_caught_at
     ) VALUES (
       $1, $2, 1, 1, now(), now(), now(), now(),
       CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       CASE WHEN $3::boolean THEN 1 ELSE 0 END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END,
       CASE WHEN $3::boolean THEN now() ELSE NULL END
     )
     ON CONFLICT (player_id, species_id)
     DO UPDATE SET
       seen_count = GREATEST(player_pokedex_species.seen_count, 1),
       caught_count = GREATEST(player_pokedex_species.caught_count, 1),
       first_seen_at = COALESCE(player_pokedex_species.first_seen_at, now()),
       last_seen_at = COALESCE(player_pokedex_species.last_seen_at, now()),
       first_caught_at = COALESCE(player_pokedex_species.first_caught_at, now()),
       last_caught_at = COALESCE(player_pokedex_species.last_caught_at, now()),
       shiny_seen_count = CASE
         WHEN $3::boolean THEN GREATEST(player_pokedex_species.shiny_seen_count, 1)
         ELSE player_pokedex_species.shiny_seen_count
       END,
       shiny_caught_count = CASE
         WHEN $3::boolean THEN GREATEST(player_pokedex_species.shiny_caught_count, 1)
         ELSE player_pokedex_species.shiny_caught_count
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
       first_shiny_caught_at = CASE
         WHEN $3::boolean
           THEN COALESCE(player_pokedex_species.first_shiny_caught_at, now())
         ELSE player_pokedex_species.first_shiny_caught_at
       END,
       last_shiny_caught_at = CASE
         WHEN $3::boolean
           THEN COALESCE(player_pokedex_species.last_shiny_caught_at, now())
         ELSE player_pokedex_species.last_shiny_caught_at
       END,
       revision = player_pokedex_species.revision + 1`,
    [playerId, speciesId, shiny],
  );
}

export async function recordPokedexOwnedByForm(
  client: PoolClient,
  playerId: string,
  formId: string,
  shiny = false,
): Promise<void> {
  const species = await client.query<{ species_id: string }>(
    "SELECT species_id FROM pokemon_forms WHERE id = $1",
    [formId],
  );
  const speciesId = species.rows[0]?.species_id;
  if (speciesId === undefined) throw new Error("Pokédex ownership form has no species identity");
  await recordPokedexOwned(client, playerId, speciesId, shiny);
}
