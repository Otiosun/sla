import type { Pool } from "pg";
import {
  OnboardingStateSchema,
  type PlayerProfileView,
  type RosterPlacement,
  type StarterBuild,
  type StarterGrantRecord,
  type StarterGrantWrite,
  type StarterMoveCandidate,
  type StarterOption,
} from "../../modules/player/contracts.js";
import type {
  PlayerOnboardingRepository,
  PlayerOnboardingTransaction,
} from "../../modules/player/ports.js";
import {
  type PlayerId,
  type PokemonInstanceId,
  parsePlayerId,
  parsePokemonInstanceId,
} from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";
import { PostgresPlayerRegistrationTransaction } from "./postgres-player-registration-transaction.js";

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function pokemonId(value: string): PokemonInstanceId {
  const parsed = parsePokemonInstanceId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PokemonInstanceId");
  return parsed.value;
}

class PostgresPlayerOnboardingTransaction
  extends PostgresPlayerRegistrationTransaction
  implements PlayerOnboardingTransaction
{
  public async listStarterOptions(
    contentReleaseId: string,
    regionId: string,
  ): Promise<readonly StarterOption[]> {
    const result = await this.client.query<{
      form_id: string;
      display_name: string;
      starter_level: number;
      sort_order: number;
    }>(
      `SELECT option.form_id, species.display_name, option.starter_level, option.sort_order
       FROM starter_options option
       JOIN pokemon_form_revisions form
         ON form.content_release_id = option.content_release_id
        AND form.form_id = option.form_id AND form.active = TRUE
       JOIN pokemon_forms identity ON identity.id = option.form_id
       JOIN pokemon_species_revisions species
         ON species.content_release_id = option.content_release_id
        AND species.species_id = identity.species_id AND species.active = TRUE
       JOIN region_revisions region
         ON region.content_release_id = option.content_release_id
        AND region.region_id = option.region_id AND region.active = TRUE
       WHERE option.content_release_id = $1 AND option.region_id = $2 AND option.active = TRUE
       ORDER BY option.sort_order, species.display_name, option.form_id`,
      [contentReleaseId, regionId],
    );
    return result.rows.map((row) => ({
      formId: row.form_id,
      displayName: row.display_name,
      starterLevel: row.starter_level,
      sortOrder: row.sort_order,
    }));
  }

  public async setStarterPending(input: {
    readonly playerId: PlayerId;
    readonly starterClaimKey: string;
    readonly expectedRevision: bigint;
  }): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE onboarding_states
       SET state = 'STARTER_PENDING', starter_claim_key = $2,
           revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND state = 'REGION_SELECTED' AND revision = $3`,
      [input.playerId, input.starterClaimKey, input.expectedRevision.toString()],
    );
    return result.rowCount === 1;
  }

  public async findStarterGrant(playerIdValue: PlayerId): Promise<StarterGrantRecord | null> {
    const result = await this.client.query<{
      player_id: string;
      pokemon_instance_id: string;
      form_id: string | null;
      idempotency_key: string;
    }>(
      `SELECT player_id, pokemon_instance_id, form_id, idempotency_key
       FROM starter_grants WHERE player_id = $1`,
      [playerIdValue],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          playerId: playerId(row.player_id),
          pokemonInstanceId: pokemonId(row.pokemon_instance_id),
          formId: row.form_id,
          idempotencyKey: row.idempotency_key,
        };
  }

  public async loadStarterBuild(input: {
    readonly contentReleaseId: string;
    readonly rulesetId: string;
    readonly regionId: string;
    readonly formId: string;
  }): Promise<StarterBuild | null> {
    const option = await this.client.query<{ starter_level: number; base_hp: number }>(
      `SELECT starter.starter_level, form.base_hp
       FROM starter_options starter
       JOIN content_releases release
         ON release.id = starter.content_release_id
        AND release.default_ruleset_id = $2
        AND release.status IN ('PUBLISHED', 'ARCHIVED')
       JOIN pokemon_form_revisions form
         ON form.content_release_id = starter.content_release_id
        AND form.form_id = starter.form_id AND form.active = TRUE
       JOIN region_revisions region
         ON region.content_release_id = starter.content_release_id
        AND region.region_id = starter.region_id AND region.active = TRUE
       WHERE starter.content_release_id = $1 AND starter.region_id = $3
         AND starter.form_id = $4 AND starter.active = TRUE`,
      [input.contentReleaseId, input.rulesetId, input.regionId, input.formId],
    );
    const optionRow = option.rows[0];
    if (optionRow === undefined) return null;

    const [abilities, natures, moves] = await Promise.all([
      this.client.query<{ ability_id: string }>(
        `SELECT option.ability_id
         FROM pokemon_form_ability_options option
         JOIN ability_revisions ability
           ON ability.content_release_id = option.content_release_id
          AND ability.ability_id = option.ability_id AND ability.active = TRUE
         WHERE option.content_release_id = $1 AND option.form_id = $2 AND option.active = TRUE
         ORDER BY option.slot_kind, option.ability_id`,
        [input.contentReleaseId, input.formId],
      ),
      this.client.query<{ nature_id: string }>(
        `SELECT nature_id FROM nature_revisions
         WHERE content_release_id = $1 AND active = TRUE ORDER BY nature_id`,
        [input.contentReleaseId],
      ),
      this.client.query<{
        move_id: string;
        max_pp: number | null;
        learn_method: "START" | "LEVEL";
        learn_level: number | null;
      }>(
        `SELECT learnset.move_id, move.max_pp, learnset.learn_method, learnset.learn_level
         FROM move_learnset_entries learnset
         JOIN move_revisions move
           ON move.content_release_id = learnset.content_release_id
          AND move.move_id = learnset.move_id AND move.active = TRUE
         WHERE learnset.content_release_id = $1 AND learnset.form_id = $2
           AND learnset.active = TRUE AND learnset.learn_method IN ('START', 'LEVEL')
           AND (learnset.learn_method = 'START' OR learnset.learn_level <= $3)
         ORDER BY CASE learnset.learn_method WHEN 'START' THEN 0 ELSE 1 END,
                  learnset.learn_level NULLS FIRST, learnset.move_id`,
        [input.contentReleaseId, input.formId, optionRow.starter_level],
      ),
    ]);

    const moveCandidates: StarterMoveCandidate[] = moves.rows.map((row) => {
      if (row.max_pp === null) throw new Error("Starter move is missing max PP");
      return {
        moveId: row.move_id,
        maxPp: row.max_pp,
        learnMethod: row.learn_method,
        learnLevel: row.learn_level,
      };
    });
    return {
      contentReleaseId: input.contentReleaseId,
      rulesetId: input.rulesetId,
      regionId: input.regionId,
      formId: input.formId,
      starterLevel: optionRow.starter_level,
      baseHp: optionRow.base_hp,
      abilityIds: abilities.rows.map((row) => row.ability_id),
      natureIds: natures.rows.map((row) => row.nature_id),
      moves: moveCandidates,
    };
  }

  public async nextRosterPlacement(playerIdValue: PlayerId): Promise<RosterPlacement> {
    const team = await this.client.query<{ slot_no: number }>(
      `SELECT slot_no FROM pokemon_roster_slots
       WHERE player_id = $1 AND placement_kind = 'TEAM' ORDER BY slot_no`,
      [playerIdValue],
    );
    const occupied = new Set(team.rows.map((row) => row.slot_no));
    for (let slot = 1; slot <= 6; slot += 1) {
      if (!occupied.has(slot)) return { placementKind: "TEAM", boxNo: null, slotNo: slot };
    }
    const box = await this.client.query<{ next_slot: number }>(
      `SELECT COALESCE(MAX(slot_no), 0) + 1 AS next_slot
       FROM pokemon_roster_slots
       WHERE player_id = $1 AND placement_kind = 'BOX' AND box_no = 1`,
      [playerIdValue],
    );
    return { placementKind: "BOX", boxNo: 1, slotNo: box.rows[0]?.next_slot ?? 1 };
  }

  public async createStarterBundle(input: StarterGrantWrite): Promise<boolean> {
    const advanced = await this.client.query(
      `UPDATE onboarding_states
       SET state = 'STARTER_GRANTED', revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND state = 'STARTER_PENDING'
         AND starter_claim_key = $2 AND revision = $3`,
      [input.playerId, input.idempotencyKey, input.expectedOnboardingRevision.toString()],
    );
    if (advanced.rowCount !== 1) return false;

    await this.client.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, level, current_hp, ability_id, origin_type, origin_id
       ) VALUES ($1, $2, $3, $4, $5, $6, 'STARTER', $7)`,
      [
        input.pokemonInstanceId,
        input.playerId,
        input.formId,
        input.generated.level,
        input.generated.currentHp,
        input.generated.abilityId,
        input.grantId,
      ],
    );
    await this.client.query(
      `INSERT INTO pokemon_training_values(
         pokemon_instance_id, nature_id, iv_hp, iv_attack, iv_defense,
         iv_sp_attack, iv_sp_defense, iv_speed
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.pokemonInstanceId,
        input.generated.natureId,
        input.generated.ivs.hp,
        input.generated.ivs.attack,
        input.generated.ivs.defense,
        input.generated.ivs.spAttack,
        input.generated.ivs.spDefense,
        input.generated.ivs.speed,
      ],
    );
    for (const [index, move] of input.generated.moves.entries()) {
      await this.client.query(
        `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
         VALUES ($1, $2, $3, $4)`,
        [input.pokemonInstanceId, index + 1, move.moveId, move.ppCurrent],
      );
    }
    await this.client.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        input.pokemonInstanceId,
        input.playerId,
        input.placement.placementKind,
        input.placement.boxNo,
        input.placement.slotNo,
      ],
    );
    await this.client.query(
      `INSERT INTO starter_grants(
         id, player_id, idempotency_key, pokemon_instance_id, content_release_id,
         ruleset_id, region_id, form_id, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.grantId,
        input.playerId,
        input.idempotencyKey,
        input.pokemonInstanceId,
        input.contentReleaseId,
        input.rulesetId,
        input.regionId,
        input.formId,
        input.correlationId,
      ],
    );
    await this.client.query(
      `INSERT INTO pokemon_history_events(
         id, pokemon_instance_id, event_type, payload, actor_type, correlation_id
       ) VALUES ($1, $2, 'STARTER_GRANTED', $3::jsonb, 'SYSTEM', $4)`,
      [
        input.historyEventId,
        input.pokemonInstanceId,
        JSON.stringify({
          contentReleaseId: input.contentReleaseId,
          rulesetId: input.rulesetId,
          regionId: input.regionId,
          formId: input.formId,
        }),
        input.correlationId,
      ],
    );
    return true;
  }

  public async completeOnboarding(input: {
    readonly playerId: PlayerId;
    readonly completedAt: Date;
    readonly expectedRevision: bigint;
  }): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE onboarding_states
       SET state = 'COMPLETE', completed_at = $2, revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND state = 'STARTER_GRANTED' AND revision = $3`,
      [input.playerId, input.completedAt, input.expectedRevision.toString()],
    );
    return result.rowCount === 1;
  }

  public async loadProfileView(playerIdValue: PlayerId): Promise<PlayerProfileView | null> {
    const result = await this.client.query<{
      player_id: string;
      player_status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
      trainer_name: string | null;
      origin_region_id: string | null;
      locale: string | null;
      level: number;
      progression_points: string;
      onboarding_state: string;
      content_release_id: string;
      ruleset_id: string;
      starter_pokemon_instance_id: string | null;
    }>(
      `SELECT player.id AS player_id, player.status AS player_status,
              profile.trainer_name, profile.origin_region_id, profile.locale,
              progression.level, progression.progression_points::text,
              onboarding.state AS onboarding_state,
              context.content_release_id, context.ruleset_id,
              starter.pokemon_instance_id AS starter_pokemon_instance_id
       FROM players player
       JOIN trainer_progression progression ON progression.player_id = player.id
       JOIN onboarding_states onboarding ON onboarding.player_id = player.id
       JOIN player_onboarding_context context ON context.player_id = player.id
       LEFT JOIN player_profiles profile ON profile.player_id = player.id
       LEFT JOIN starter_grants starter ON starter.player_id = player.id
       WHERE player.id = $1`,
      [playerIdValue],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const team = await this.client.query<{
      pokemon_instance_id: string;
      form_id: string;
      level: number;
      current_hp: number;
      slot_no: number;
    }>(
      `SELECT pokemon.id AS pokemon_instance_id, pokemon.form_id, pokemon.level,
              pokemon.current_hp, roster.slot_no
       FROM pokemon_roster_slots roster
       JOIN pokemon_instances pokemon ON pokemon.id = roster.pokemon_instance_id
       WHERE roster.player_id = $1 AND roster.placement_kind = 'TEAM'
       ORDER BY roster.slot_no`,
      [playerIdValue],
    );
    return {
      playerId: playerId(row.player_id),
      playerStatus: row.player_status,
      trainerName: row.trainer_name,
      originRegionId: row.origin_region_id,
      locale: row.locale,
      trainerLevel: row.level,
      progressionPoints: BigInt(row.progression_points),
      onboardingState: OnboardingStateSchema.parse(row.onboarding_state),
      contentReleaseId: row.content_release_id,
      rulesetId: row.ruleset_id,
      starterPokemonInstanceId:
        row.starter_pokemon_instance_id === null
          ? null
          : pokemonId(row.starter_pokemon_instance_id),
      team: team.rows.map((member) => ({
        pokemonInstanceId: pokemonId(member.pokemon_instance_id),
        formId: member.form_id,
        level: member.level,
        currentHp: member.current_hp,
        slotNo: member.slot_no,
      })),
    };
  }
}

export class PostgresPlayerOnboardingRepository implements PlayerOnboardingRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    work: (transaction: PlayerOnboardingTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresPlayerOnboardingTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (transaction: PlayerOnboardingTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresPlayerOnboardingTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
