import type { Pool } from "pg";

export interface AdminWhatsAppPokemonTarget {
  readonly pokemonInstanceId: string;
  readonly displayName: string;
  readonly speciesSlug: string;
  readonly level: number;
  readonly xp: string;
  readonly ordinal: number;
}

export type AdminWhatsAppPokemonResolution =
  | { readonly status: "RESOLVED"; readonly target: AdminWhatsAppPokemonTarget }
  | { readonly status: "MISSING" }
  | { readonly status: "AMBIGUOUS"; readonly candidates: readonly AdminWhatsAppPokemonTarget[] };

function normalize(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR");
}

export class PostgresAdminWhatsAppPokemonTargetResolver {
  public constructor(private readonly pool: Pool) {}

  public async resolve(
    playerId: string,
    selector: string,
  ): Promise<AdminWhatsAppPokemonResolution> {
    const result = await this.pool.query<{
      id: string;
      species_slug: string;
      form_slug: string;
      nickname: string | null;
      level: number;
      xp: string;
    }>(
      `SELECT pokemon.id,
              species.slug AS species_slug,
              form.slug AS form_slug,
              pokemon.nickname,
              pokemon.level,
              pokemon.xp::text
       FROM pokemon_instances pokemon
       JOIN pokemon_forms form ON form.id = pokemon.form_id
       JOIN pokemon_species species ON species.id = form.species_id
       LEFT JOIN pokemon_roster_slots roster
         ON roster.pokemon_instance_id = pokemon.id
        AND roster.player_id = pokemon.owner_player_id
       WHERE pokemon.owner_player_id = $1
         AND pokemon.status = 'ACTIVE'
       ORDER BY
         CASE roster.placement_kind WHEN 'TEAM' THEN 0 WHEN 'BOX' THEN 1 ELSE 2 END,
         roster.box_no NULLS FIRST,
         roster.slot_no NULLS FIRST,
         pokemon.created_at,
         pokemon.id`,
      [playerId],
    );

    const targets: AdminWhatsAppPokemonTarget[] = result.rows.map((row, index) => ({
      pokemonInstanceId: row.id,
      displayName: row.nickname?.trim() || row.species_slug,
      speciesSlug: row.species_slug,
      level: row.level,
      xp: row.xp,
      ordinal: index + 1,
    }));
    if (targets.length === 0) return { status: "MISSING" };

    const clean = selector
      .trim()
      .replace(/^(?:pokemon|pokémon|poke)\s+/iu, "")
      .trim();
    const ordinalMatch = clean.match(/^#?(\d+)$/u);
    if (ordinalMatch !== null) {
      const ordinal = Number(ordinalMatch[1]);
      const target = targets[ordinal - 1];
      return target === undefined ? { status: "MISSING" } : { status: "RESOLVED", target };
    }

    const key = normalize(clean);
    if (key.length === 0) return { status: "MISSING" };
    const exact = targets.filter(
      (target) => normalize(target.displayName) === key || normalize(target.speciesSlug) === key,
    );
    const exactTarget = exact[0];
    if (exact.length === 1 && exactTarget !== undefined) {
      return { status: "RESOLVED", target: exactTarget };
    }
    if (exact.length > 1) return { status: "AMBIGUOUS", candidates: exact.slice(0, 6) };

    const prefix = targets.filter(
      (target) =>
        normalize(target.displayName).startsWith(key) ||
        normalize(target.speciesSlug).startsWith(key),
    );
    const prefixTarget = prefix[0];
    if (prefix.length === 1 && prefixTarget !== undefined) {
      return { status: "RESOLVED", target: prefixTarget };
    }
    if (prefix.length > 1) return { status: "AMBIGUOUS", candidates: prefix.slice(0, 6) };
    return { status: "MISSING" };
  }
}
