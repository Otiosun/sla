import type { PoolClient } from "pg";
import {
  type ContentContext,
  type ExternalIdentity,
  type OnboardingRecord,
  OnboardingStateSchema,
  type ProfileInput,
  type RosterPlacement,
} from "../../modules/player/contracts.js";
import type {
  OwnedPokemonRecord,
  PlayerPokedexSpeciesRecord,
  StoredProfile,
} from "../../modules/player/ports.js";
import {
  type PlayerId,
  type PokemonInstanceId,
  parsePlayerId,
  parsePokemonInstanceId,
} from "../../shared-kernel/ids.js";

function asPlayerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function asPokemonInstanceId(value: string): PokemonInstanceId {
  const parsed = parsePokemonInstanceId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PokemonInstanceId");
  return parsed.value;
}

function asMetadata(value: unknown): Readonly<Record<string, never>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Player profile metadata is not an object");
  }
  return value as Readonly<Record<string, never>>;
}

export class PostgresPlayerRegistrationTransaction {
  public constructor(protected readonly client: PoolClient) {}

  public async acquireIdentityLock(identity: ExternalIdentity): Promise<void> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${identity.provider}:${identity.externalId}`,
    ]);
  }

  public async findPlayerByIdentity(identity: ExternalIdentity): Promise<PlayerId | null> {
    const result = await this.client.query<{ player_id: string }>(
      `SELECT player_id FROM player_identities
       WHERE provider = $1 AND external_id = $2 AND status = 'ACTIVE'`,
      [identity.provider, identity.externalId],
    );
    const row = result.rows[0];
    return row === undefined ? null : asPlayerId(row.player_id);
  }

  public async listOwnedPokemon(playerId: PlayerId): Promise<readonly OwnedPokemonRecord[]> {
    const result = await this.client.query<{
      pokemon_instance_id: string;
      form_id: string;
      nickname: string | null;
      level: number;
      current_hp: number;
      gender: string | null;
      shiny: boolean;
      placement_kind: "TEAM" | "BOX";
      box_no: number | null;
      slot_no: number;
    }>(
      `SELECT pokemon.id AS pokemon_instance_id, pokemon.form_id, pokemon.nickname,
              pokemon.level, pokemon.current_hp, pokemon.gender, pokemon.shiny,
              roster.placement_kind, roster.box_no, roster.slot_no
       FROM pokemon_instances pokemon
       JOIN pokemon_roster_slots roster
         ON roster.pokemon_instance_id = pokemon.id
        AND roster.player_id = pokemon.owner_player_id
       WHERE pokemon.owner_player_id = $1 AND pokemon.status = 'ACTIVE'
       ORDER BY CASE roster.placement_kind WHEN 'TEAM' THEN 0 ELSE 1 END,
                roster.box_no NULLS FIRST, roster.slot_no, pokemon.id`,
      [playerId],
    );

    return result.rows.map((row) => ({
      pokemonInstanceId: asPokemonInstanceId(row.pokemon_instance_id),
      formId: row.form_id,
      nickname: row.nickname,
      level: row.level,
      currentHp: row.current_hp,
      gender: row.gender,
      shiny: row.shiny,
      placementKind: row.placement_kind,
      boxNo: row.box_no,
      slotNo: row.slot_no,
    }));
  }

  public async moveOwnedPokemon(input: {
    readonly playerId: PlayerId;
    readonly pokemonInstanceId: PokemonInstanceId;
    readonly target: RosterPlacement;
  }): Promise<boolean> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `roster:${input.playerId}`,
    ]);

    const roster = await this.client.query<{
      pokemon_instance_id: string;
      placement_kind: "TEAM" | "BOX";
      box_no: number | null;
      slot_no: number;
      pokemon_status: "ACTIVE" | "ARCHIVED";
    }>(
      `SELECT roster.pokemon_instance_id, roster.placement_kind, roster.box_no, roster.slot_no,
              pokemon.status AS pokemon_status
       FROM pokemon_roster_slots roster
       JOIN pokemon_instances pokemon
         ON pokemon.id = roster.pokemon_instance_id
        AND pokemon.owner_player_id = roster.player_id
       WHERE roster.player_id = $1
       ORDER BY roster.pokemon_instance_id
       FOR UPDATE OF roster`,
      [input.playerId],
    );

    const source = roster.rows.find((row) => row.pokemon_instance_id === input.pokemonInstanceId);
    if (source === undefined || source.pokemon_status !== "ACTIVE") return false;

    const alreadyThere =
      source.placement_kind === input.target.placementKind &&
      source.box_no === input.target.boxNo &&
      source.slot_no === input.target.slotNo;
    if (alreadyThere) return true;

    const occupant = roster.rows.find(
      (row) =>
        row.placement_kind === input.target.placementKind &&
        row.box_no === input.target.boxNo &&
        row.slot_no === input.target.slotNo,
    );

    if (occupant === undefined) {
      const moved = await this.client.query(
        `UPDATE pokemon_roster_slots
         SET placement_kind = $3, box_no = $4, slot_no = $5, updated_at = now()
         WHERE player_id = $1 AND pokemon_instance_id = $2`,
        [
          input.playerId,
          input.pokemonInstanceId,
          input.target.placementKind,
          input.target.boxNo,
          input.target.slotNo,
        ],
      );
      return moved.rowCount === 1;
    }

    await this.client.query(
      `DELETE FROM pokemon_roster_slots
       WHERE player_id = $1 AND pokemon_instance_id = ANY($2::uuid[])`,
      [input.playerId, [input.pokemonInstanceId, occupant.pokemon_instance_id]],
    );
    await this.client.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES
         ($1, $3, $4, $5, $6),
         ($2, $3, $7, $8, $9)`,
      [
        input.pokemonInstanceId,
        occupant.pokemon_instance_id,
        input.playerId,
        input.target.placementKind,
        input.target.boxNo,
        input.target.slotNo,
        source.placement_kind,
        source.box_no,
        source.slot_no,
      ],
    );
    return true;
  }

  public async listPokedexSpecies(
    playerId: PlayerId,
  ): Promise<readonly PlayerPokedexSpeciesRecord[]> {
    const result = await this.client.query<{
      national_dex: number;
      seen_count: string;
      caught_count: string;
      first_seen_at: Date | null;
      last_seen_at: Date | null;
      first_caught_at: Date | null;
      last_caught_at: Date | null;
    }>(
      `SELECT species.national_dex,
              pokedex.seen_count::text, pokedex.caught_count::text,
              pokedex.first_seen_at, pokedex.last_seen_at,
              pokedex.first_caught_at, pokedex.last_caught_at
       FROM player_pokedex_species pokedex
       JOIN pokemon_species species ON species.id = pokedex.species_id
       WHERE pokedex.player_id = $1
       ORDER BY species.national_dex`,
      [playerId],
    );

    return result.rows.map((row) => ({
      nationalDex: row.national_dex,
      seenCount: BigInt(row.seen_count),
      caughtCount: BigInt(row.caught_count),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      firstCaughtAt: row.first_caught_at,
      lastCaughtAt: row.last_caught_at,
    }));
  }

  public async loadActiveContentContext(): Promise<ContentContext | null> {
    const result = await this.client.query<{
      content_release_id: string;
      ruleset_id: string;
    }>(
      `SELECT pointer.content_release_id, release.default_ruleset_id AS ruleset_id
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id = pointer.content_release_id
       JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
       WHERE pointer.pointer_key = 'ACTIVE'
         AND release.status = 'PUBLISHED'
         AND ruleset.status = 'PUBLISHED'`,
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { contentReleaseId: row.content_release_id, rulesetId: row.ruleset_id };
  }

  public async createPlayerFoundation(input: {
    readonly playerId: PlayerId;
    readonly identityId: string;
    readonly identity: ExternalIdentity;
    readonly context: ContentContext;
  }): Promise<void> {
    await this.client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [
      input.playerId,
    ]);
    await this.client.query(
      `INSERT INTO player_identities(id, player_id, provider, external_id, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')`,
      [input.identityId, input.playerId, input.identity.provider, input.identity.externalId],
    );
    await this.client.query(
      "INSERT INTO trainer_progression(player_id, level, progression_points) VALUES ($1, 1, 0)",
      [input.playerId],
    );
    await this.client.query("INSERT INTO onboarding_states(player_id, state) VALUES ($1, 'NEW')", [
      input.playerId,
    ]);
    await this.client.query(
      `INSERT INTO player_onboarding_context(player_id, content_release_id, ruleset_id)
       VALUES ($1, $2, $3)`,
      [input.playerId, input.context.contentReleaseId, input.context.rulesetId],
    );
  }

  public async loadOnboarding(playerId: PlayerId, lock = false): Promise<OnboardingRecord | null> {
    if (lock) {
      const locked = await this.client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [
        playerId,
      ]);
      if (locked.rowCount !== 1) return null;
    }
    const result = await this.client.query<{
      player_id: string;
      player_status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
      state: string;
      starter_claim_key: string | null;
      completed_at: Date | null;
      revision: string;
      content_release_id: string;
      ruleset_id: string;
      origin_region_id: string | null;
    }>(
      `SELECT state.player_id, player.status AS player_status, state.state,
              state.starter_claim_key, state.completed_at, state.revision::text,
              context.content_release_id, context.ruleset_id, profile.origin_region_id
       FROM onboarding_states state
       JOIN players player ON player.id = state.player_id
       JOIN player_onboarding_context context ON context.player_id = state.player_id
       LEFT JOIN player_profiles profile ON profile.player_id = state.player_id
       WHERE state.player_id = $1`,
      [playerId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      playerId: asPlayerId(row.player_id),
      playerStatus: row.player_status,
      state: OnboardingStateSchema.parse(row.state),
      starterClaimKey: row.starter_claim_key,
      completedAt: row.completed_at,
      revision: BigInt(row.revision),
      contentReleaseId: row.content_release_id,
      rulesetId: row.ruleset_id,
      originRegionId: row.origin_region_id,
    };
  }

  public async loadProfile(playerId: PlayerId): Promise<StoredProfile | null> {
    const result = await this.client.query<{
      trainer_name: string;
      locale: string | null;
      metadata: unknown;
      origin_region_id: string | null;
    }>(
      `SELECT trainer_name, locale, metadata, origin_region_id
       FROM player_profiles WHERE player_id = $1`,
      [playerId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          trainerName: row.trainer_name,
          locale: row.locale,
          metadata: asMetadata(row.metadata),
          originRegionId: row.origin_region_id,
        };
  }

  public async createProfile(input: {
    readonly playerId: PlayerId;
    readonly profile: ProfileInput;
    readonly expectedRevision: bigint;
  }): Promise<boolean> {
    const advanced = await this.client.query(
      `UPDATE onboarding_states
       SET state = 'PROFILE_CREATED', revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND state = 'NEW' AND revision = $2`,
      [input.playerId, input.expectedRevision.toString()],
    );
    if (advanced.rowCount !== 1) return false;
    await this.client.query(
      `INSERT INTO player_profiles(player_id, trainer_name, locale, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        input.playerId,
        input.profile.trainerName,
        input.profile.locale ?? null,
        JSON.stringify(input.profile.metadata),
      ],
    );
    return true;
  }

  public async regionIsActive(contentReleaseId: string, regionId: string): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1 FROM region_revisions
       WHERE content_release_id = $1 AND region_id = $2 AND active = TRUE`,
      [contentReleaseId, regionId],
    );
    return result.rowCount === 1;
  }

  public async selectRegion(input: {
    readonly playerId: PlayerId;
    readonly regionId: string;
    readonly expectedRevision: bigint;
  }): Promise<boolean> {
    const advanced = await this.client.query(
      `UPDATE onboarding_states
       SET state = 'REGION_SELECTED', revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND state = 'PROFILE_CREATED' AND revision = $2`,
      [input.playerId, input.expectedRevision.toString()],
    );
    if (advanced.rowCount !== 1) return false;
    const profile = await this.client.query(
      `UPDATE player_profiles
       SET origin_region_id = $2, revision = revision + 1, updated_at = now()
       WHERE player_id = $1`,
      [input.playerId, input.regionId],
    );
    if (profile.rowCount !== 1)
      throw new Error("Player profile disappeared during region selection");
    return true;
  }
}
