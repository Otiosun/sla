import type { Pool, PoolClient } from "pg";
import {
  PlayerStatusSchema,
  type Player360ActivityView,
  type Player360BattleView,
  type Player360EffectView,
  type Player360EncounterView,
  type Player360IdentityView,
  type Player360InventoryView,
  type Player360PokedexEntryView,
  type Player360PokemonView,
  type Player360SearchItemView,
  type Player360View,
  type Player360WalletView,
} from "../../modules/admin/player360-contracts.js";
import type {
  Player360ReadRepository,
  Player360SearchQuery,
} from "../../modules/admin/player360-ports.js";
import { withTransaction } from "../db/transaction.js";

function iso(value: Date): string {
  return value.toISOString();
}

function isoNullable(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

interface CoreRow {
  id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  player_revision: string;
  trainer_name: string | null;
  origin_region_id: string | null;
  locale: string | null;
  profile_metadata: Record<string, unknown> | null;
  profile_revision: string | null;
  onboarding_state: string | null;
  onboarding_completed_at: Date | null;
  onboarding_revision: string | null;
  content_release_id: string | null;
  ruleset_id: string | null;
  trainer_level: number | null;
  progression_points: string | null;
  progression_revision: string | null;
  area_id: string | null;
  entered_at: Date | null;
  location_revision: string | null;
}

interface PokemonRow {
  id: string;
  form_id: string;
  form_slug: string;
  species_id: string;
  species_slug: string;
  national_dex: number;
  nickname: string | null;
  level: number;
  xp: string;
  current_hp: number;
  gender: string | null;
  shiny: boolean;
  status: "ACTIVE" | "ARCHIVED";
  ability_id: string | null;
  ability_slug: string | null;
  nature_id: string | null;
  nature_slug: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  placement_kind: "TEAM" | "BOX" | null;
  box_no: number | null;
  slot_no: number | null;
  iv_hp: number | null;
  iv_attack: number | null;
  iv_defense: number | null;
  iv_sp_attack: number | null;
  iv_sp_defense: number | null;
  iv_speed: number | null;
}

interface SearchRow {
  player_id: string;
  status: string;
  trainer_name: string | null;
  origin_region_id: string | null;
  trainer_level: number;
  progression_points: string;
  area_id: string | null;
  active_encounter_id: string | null;
  active_encounter_status: string | null;
  active_battle_id: string | null;
  active_battle_status: string | null;
  created_at: Date;
}

async function loadIdentities(
  client: PoolClient,
  playerIds: readonly string[],
  includeSensitive: boolean,
): Promise<Map<string, Player360IdentityView[]>> {
  const byPlayer = new Map<string, Player360IdentityView[]>();
  if (playerIds.length === 0) return byPlayer;
  const result = await client.query<{
    player_id: string;
    provider: string;
    external_id: string;
    status: "ACTIVE" | "REVOKED";
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT player_id, provider, external_id, status, created_at, revoked_at
     FROM player_identities
     WHERE player_id = ANY($1::uuid[])
     ORDER BY player_id, provider, created_at, id`,
    [playerIds],
  );
  for (const row of result.rows) {
    const current = byPlayer.get(row.player_id) ?? [];
    current.push({
      provider: row.provider,
      externalId: includeSensitive ? row.external_id : null,
      status: row.status,
      createdAt: iso(row.created_at),
      revokedAt: isoNullable(row.revoked_at),
    });
    byPlayer.set(row.player_id, current);
  }
  return byPlayer;
}

export class PostgresPlayer360Repository implements Player360ReadRepository {
  public constructor(private readonly pool: Pool) {}

  public async getPlayer360(
    playerId: string,
    includeSensitive: boolean,
  ): Promise<Player360View | null> {
    return withTransaction(
      this.pool,
      async (client) => {
        const core = await client.query<CoreRow>(
          `SELECT player.id, player.status, player.created_at, player.updated_at,
                  player.revision::text AS player_revision,
                  profile.trainer_name, profile.origin_region_id, profile.locale,
                  profile.metadata AS profile_metadata,
                  profile.revision::text AS profile_revision,
                  onboarding.state AS onboarding_state,
                  onboarding.completed_at AS onboarding_completed_at,
                  onboarding.revision::text AS onboarding_revision,
                  context.content_release_id, context.ruleset_id,
                  progression.level AS trainer_level,
                  progression.progression_points::text,
                  progression.revision::text AS progression_revision,
                  location.area_id, location.entered_at,
                  location.revision::text AS location_revision
           FROM players player
           LEFT JOIN player_profiles profile ON profile.player_id = player.id
           LEFT JOIN onboarding_states onboarding ON onboarding.player_id = player.id
           LEFT JOIN player_onboarding_context context ON context.player_id = player.id
           LEFT JOIN trainer_progression progression ON progression.player_id = player.id
           LEFT JOIN player_locations location ON location.player_id = player.id
           WHERE player.id = $1`,
          [playerId],
        );
        const row = core.rows[0];
        if (row === undefined) return null;
        if (
          row.trainer_level === null ||
          row.progression_points === null ||
          row.progression_revision === null
        ) {
          throw new Error(`Player ${playerId} is missing trainer progression`);
        }

        const [
          identitiesByPlayer,
          unlocks,
          wallets,
          inventory,
          pokemonRows,
          moveRows,
          conditionRows,
          evolutionFlagRows,
          pokedexRows,
          encounterRows,
          battleRows,
          effectRows,
          activityRows,
        ] = await Promise.all([
          loadIdentities(client, [playerId], includeSensitive),
          client.query<{
            unlock_key: string;
            source_type: string;
            source_id: string;
            status: "ACTIVE" | "REVOKED";
            unlocked_at: Date;
            revoked_at: Date | null;
            revision: string;
          }>(
            `SELECT unlock_key, source_type, source_id, status, unlocked_at, revoked_at,
                    revision::text
             FROM trainer_unlocks
             WHERE player_id = $1
             ORDER BY unlock_key`,
            [playerId],
          ),
          client.query<{
            currency_id: string;
            slug: string;
            display_name: string;
            amount: string;
            revision: string;
            updated_at: Date;
          }>(
            `SELECT balance.currency_id, currency.slug, currency.display_name,
                    balance.amount::text, balance.revision::text, balance.updated_at
             FROM wallet_balances balance
             JOIN currency_definitions currency ON currency.id = balance.currency_id
             WHERE balance.player_id = $1
             ORDER BY currency.slug, balance.currency_id`,
            [playerId],
          ),
          client.query<{
            item_id: string;
            slug: string;
            quantity: string;
            revision: string;
            updated_at: Date;
          }>(
            `SELECT balance.item_id, item.slug, balance.quantity::text,
                    balance.revision::text, balance.updated_at
             FROM inventory_balances balance
             JOIN items item ON item.id = balance.item_id
             WHERE balance.player_id = $1
             ORDER BY item.slug, balance.item_id`,
            [playerId],
          ),
          client.query<PokemonRow>(
            `SELECT pokemon.id, pokemon.form_id, form.slug AS form_slug,
                    species.id AS species_id, species.slug AS species_slug,
                    species.national_dex, pokemon.nickname, pokemon.level,
                    pokemon.xp::text, pokemon.current_hp, pokemon.gender, pokemon.shiny,
                    pokemon.status, pokemon.ability_id, ability.slug AS ability_slug,
                    training.nature_id, nature.slug AS nature_slug,
                    pokemon.revision::text, pokemon.created_at, pokemon.updated_at,
                    roster.placement_kind, roster.box_no, roster.slot_no,
                    training.iv_hp, training.iv_attack, training.iv_defense,
                    training.iv_sp_attack, training.iv_sp_defense, training.iv_speed
             FROM pokemon_instances pokemon
             JOIN pokemon_forms form ON form.id = pokemon.form_id
             JOIN pokemon_species species ON species.id = form.species_id
             LEFT JOIN abilities ability ON ability.id = pokemon.ability_id
             LEFT JOIN pokemon_training_values training
               ON training.pokemon_instance_id = pokemon.id
             LEFT JOIN natures nature ON nature.id = training.nature_id
             LEFT JOIN pokemon_roster_slots roster
               ON roster.pokemon_instance_id = pokemon.id AND roster.player_id = pokemon.owner_player_id
             WHERE pokemon.owner_player_id = $1
             ORDER BY
               CASE roster.placement_kind WHEN 'TEAM' THEN 0 WHEN 'BOX' THEN 1 ELSE 2 END,
               roster.box_no NULLS FIRST, roster.slot_no NULLS FIRST,
               pokemon.created_at, pokemon.id`,
            [playerId],
          ),
          client.query<{
            pokemon_instance_id: string;
            slot_no: number;
            move_id: string;
            slug: string;
            pp_current: number | null;
            learned_at: Date;
          }>(
            `SELECT slot.pokemon_instance_id, slot.slot_no, slot.move_id, move.slug,
                    slot.pp_current, slot.learned_at
             FROM pokemon_move_slots slot
             JOIN moves move ON move.id = slot.move_id
             JOIN pokemon_instances pokemon ON pokemon.id = slot.pokemon_instance_id
             WHERE pokemon.owner_player_id = $1
             ORDER BY slot.pokemon_instance_id, slot.slot_no`,
            [playerId],
          ),
          client.query<{
            pokemon_instance_id: string;
            condition_key: string;
            source_type: string;
            source_id: string;
            applied_at: Date;
            expires_at: Date | null;
          }>(
            `SELECT condition.pokemon_instance_id, condition.condition_key,
                    condition.source_type, condition.source_id,
                    condition.applied_at, condition.expires_at
             FROM pokemon_persistent_conditions condition
             JOIN pokemon_instances pokemon ON pokemon.id = condition.pokemon_instance_id
             WHERE pokemon.owner_player_id = $1
             ORDER BY condition.pokemon_instance_id, condition.condition_key`,
            [playerId],
          ),
          client.query<{
            pokemon_instance_id: string;
            condition_key: string;
            status: "ACTIVE" | "REVOKED";
            source_type: string;
            source_id: string;
            granted_at: Date;
            revoked_at: Date | null;
            revision: string;
          }>(
            `SELECT flag.pokemon_instance_id, flag.condition_key, flag.status,
                    flag.source_type, flag.source_id, flag.granted_at, flag.revoked_at,
                    flag.revision::text
             FROM pokemon_evolution_condition_flags flag
             JOIN pokemon_instances pokemon ON pokemon.id = flag.pokemon_instance_id
             WHERE pokemon.owner_player_id = $1
             ORDER BY flag.pokemon_instance_id, flag.condition_key`,
            [playerId],
          ),
          client.query<{
            species_id: string;
            national_dex: number;
            slug: string;
            seen_count: string;
            caught_count: string;
            first_seen_at: Date | null;
            last_seen_at: Date | null;
            first_caught_at: Date | null;
            last_caught_at: Date | null;
          }>(
            `SELECT entry.species_id, species.national_dex, species.slug,
                    entry.seen_count::text, entry.caught_count::text,
                    entry.first_seen_at, entry.last_seen_at,
                    entry.first_caught_at, entry.last_caught_at
             FROM player_pokedex_species entry
             JOIN pokemon_species species ON species.id = entry.species_id
             WHERE entry.player_id = $1
             ORDER BY species.national_dex, entry.species_id`,
            [playerId],
          ),
          client.query<{
            id: string;
            status: string;
            area_id: string;
            content_release_id: string;
            ruleset_id: string;
            encounter_revision: string;
            created_at: Date;
            updated_at: Date;
          }>(
            `SELECT id, status, area_id, content_release_id, ruleset_id,
                    revision::text AS encounter_revision, created_at, updated_at
             FROM encounters
             WHERE player_id = $1
               AND status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE')
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [playerId],
          ),
          client.query<{
            id: string;
            status: string;
            battle_type: string;
            encounter_id: string | null;
            content_release_id: string;
            ruleset_id: string;
            turn_number: number;
            version: string;
            created_at: Date;
            updated_at: Date;
            ended_at: Date | null;
          }>(
            `SELECT DISTINCT battle.id, battle.status, battle.battle_type, battle.encounter_id,
                    battle.content_release_id, battle.ruleset_id, battle.turn_number,
                    battle.version::text, battle.created_at, battle.updated_at, battle.ended_at
             FROM battles battle
             JOIN battle_sides side ON side.battle_id = battle.id
             WHERE side.player_id = $1
               AND battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
             ORDER BY battle.created_at DESC, battle.id DESC
             LIMIT 1`,
            [playerId],
          ),
          client.query<{
            id: string;
            effect_id: string;
            effect_slug: string;
            content_release_id: string;
            player_id: string | null;
            pokemon_instance_id: string | null;
          }>(
            `SELECT active.id, active.effect_id, effect.slug AS effect_slug,
                    active.content_release_id, active.player_id, active.pokemon_instance_id
             FROM active_effects active
             JOIN effects effect ON effect.id = active.effect_id
             WHERE active.player_id = $1
                OR active.pokemon_instance_id IN (
                  SELECT id FROM pokemon_instances WHERE owner_player_id = $1
                )
             ORDER BY active.starts_at, active.id`,
            [playerId],
          ),
          client.query<{
            kind: Player360ActivityView["kind"];
            occurred_at: Date;
            subject_id: string | null;
            source_type: string;
            source_id: string;
            reason: string | null;
            correlation_id: string | null;
          }>(
            `SELECT *
             FROM (
               SELECT 'TRAINER_PROGRESS'::text AS kind, created_at AS occurred_at,
                      player_id::text AS subject_id, source_type, source_id, reason,
                      correlation_id::text AS correlation_id
               FROM trainer_progress_ledger
               WHERE player_id = $1
               UNION ALL
               SELECT 'INVENTORY'::text AS kind, created_at AS occurred_at,
                      item_id::text AS subject_id, source_type, source_id, reason,
                      correlation_id::text AS correlation_id
               FROM inventory_ledger
               WHERE player_id = $1
               UNION ALL
               SELECT 'WALLET'::text AS kind, created_at AS occurred_at,
                      currency_id::text AS subject_id, source_type, source_id, reason,
                      correlation_id::text AS correlation_id
               FROM wallet_ledger
               WHERE player_id = $1
               UNION ALL
               SELECT 'POKEMON_HISTORY'::text AS kind, history.occurred_at,
                      history.pokemon_instance_id::text AS subject_id,
                      history.event_type AS source_type, history.id::text AS source_id,
                      NULL::text AS reason, history.correlation_id::text
               FROM pokemon_history_events history
               JOIN pokemon_instances pokemon ON pokemon.id = history.pokemon_instance_id
               WHERE pokemon.owner_player_id = $1
             ) activity
             ORDER BY occurred_at DESC, kind, source_id
             LIMIT 50`,
            [playerId],
          ),
        ]);

        const moves = new Map<string, Player360PokemonView["moves"][number][]>();
        for (const move of moveRows.rows) {
          const list = moves.get(move.pokemon_instance_id) ?? [];
          list.push({
            slotNo: move.slot_no,
            moveId: move.move_id,
            slug: move.slug,
            ppCurrent: move.pp_current,
            learnedAt: iso(move.learned_at),
          });
          moves.set(move.pokemon_instance_id, list);
        }

        const conditions = new Map<
          string,
          Player360PokemonView["persistentConditions"][number][]
        >();
        for (const condition of conditionRows.rows) {
          const list = conditions.get(condition.pokemon_instance_id) ?? [];
          list.push({
            key: condition.condition_key,
            sourceType: condition.source_type,
            sourceId: condition.source_id,
            appliedAt: iso(condition.applied_at),
            expiresAt: isoNullable(condition.expires_at),
          });
          conditions.set(condition.pokemon_instance_id, list);
        }

        const evolutionFlags = new Map<
          string,
          Player360PokemonView["evolutionConditionFlags"][number][]
        >();
        for (const flag of evolutionFlagRows.rows) {
          const list = evolutionFlags.get(flag.pokemon_instance_id) ?? [];
          list.push({
            key: flag.condition_key,
            status: flag.status,
            sourceType: flag.source_type,
            sourceId: flag.source_id,
            grantedAt: iso(flag.granted_at),
            revokedAt: isoNullable(flag.revoked_at),
            revision: flag.revision,
          });
          evolutionFlags.set(flag.pokemon_instance_id, list);
        }

        const pokemon: Player360PokemonView[] = pokemonRows.rows.map((entry) => ({
          id: entry.id,
          formId: entry.form_id,
          formSlug: entry.form_slug,
          speciesId: entry.species_id,
          speciesSlug: entry.species_slug,
          nationalDex: entry.national_dex,
          nickname: entry.nickname,
          level: entry.level,
          xp: entry.xp,
          currentHp: entry.current_hp,
          gender: entry.gender,
          shiny: entry.shiny,
          status: entry.status,
          abilityId: entry.ability_id,
          abilitySlug: entry.ability_slug,
          natureId: entry.nature_id,
          natureSlug: entry.nature_slug,
          revision: entry.revision,
          createdAt: iso(entry.created_at),
          updatedAt: iso(entry.updated_at),
          placement:
            entry.placement_kind === null || entry.slot_no === null
              ? null
              : {
                  kind: entry.placement_kind,
                  boxNo: entry.box_no,
                  slotNo: entry.slot_no,
                },
          ivs: {
            hp: entry.iv_hp,
            attack: entry.iv_attack,
            defense: entry.iv_defense,
            spAttack: entry.iv_sp_attack,
            spDefense: entry.iv_sp_defense,
            speed: entry.iv_speed,
          },
          moves: moves.get(entry.id) ?? [],
          persistentConditions: conditions.get(entry.id) ?? [],
          evolutionConditionFlags: evolutionFlags.get(entry.id) ?? [],
        }));

        const walletViews: Player360WalletView[] = wallets.rows.map((entry) => ({
          currencyId: entry.currency_id,
          slug: entry.slug,
          displayName: entry.display_name,
          amount: entry.amount,
          revision: entry.revision,
          updatedAt: iso(entry.updated_at),
        }));
        const inventoryViews: Player360InventoryView[] = inventory.rows.map((entry) => ({
          itemId: entry.item_id,
          slug: entry.slug,
          quantity: entry.quantity,
          revision: entry.revision,
          updatedAt: iso(entry.updated_at),
        }));
        const pokedexEntries: Player360PokedexEntryView[] = pokedexRows.rows.map((entry) => ({
          speciesId: entry.species_id,
          nationalDex: entry.national_dex,
          slug: entry.slug,
          seenCount: entry.seen_count,
          caughtCount: entry.caught_count,
          firstSeenAt: isoNullable(entry.first_seen_at),
          lastSeenAt: isoNullable(entry.last_seen_at),
          firstCaughtAt: isoNullable(entry.first_caught_at),
          lastCaughtAt: isoNullable(entry.last_caught_at),
        }));

        const encounterRow = encounterRows.rows[0];
        const activeEncounter: Player360EncounterView | null =
          encounterRow === undefined
            ? null
            : {
                id: encounterRow.id,
                status: encounterRow.status,
                areaId: encounterRow.area_id,
                contentReleaseId: encounterRow.content_release_id,
                rulesetId: encounterRow.ruleset_id,
                revision: encounterRow.encounter_revision,
                createdAt: iso(encounterRow.created_at),
                updatedAt: iso(encounterRow.updated_at),
              };

        const battleRow = battleRows.rows[0];
        const activeBattle: Player360BattleView | null =
          battleRow === undefined
            ? null
            : {
                id: battleRow.id,
                status: battleRow.status,
                battleType: battleRow.battle_type,
                encounterId: battleRow.encounter_id,
                contentReleaseId: battleRow.content_release_id,
                rulesetId: battleRow.ruleset_id,
                turnNumber: battleRow.turn_number,
                version: battleRow.version,
                createdAt: iso(battleRow.created_at),
                updatedAt: iso(battleRow.updated_at),
                endedAt: isoNullable(battleRow.ended_at),
              };

        const effects: Player360EffectView[] = effectRows.rows.map((entry) => ({
          id: entry.id,
          effectId: entry.effect_id,
          effectSlug: entry.effect_slug,
          contentReleaseId: entry.content_release_id,
          playerId: entry.player_id,
          pokemonInstanceId: entry.pokemon_instance_id,
        }));

        const recentActivity: Player360ActivityView[] = activityRows.rows.map((entry) => ({
          kind: entry.kind,
          occurredAt: iso(entry.occurred_at),
          subjectId: entry.subject_id,
          sourceType: entry.source_type,
          sourceId: entry.source_id,
          reason: entry.reason,
          correlationId: entry.correlation_id,
        }));

        return {
          player: {
            id: row.id,
            status: PlayerStatusSchema.parse(row.status),
            createdAt: iso(row.created_at),
            updatedAt: iso(row.updated_at),
            revision: row.player_revision,
          },
          profile: {
            trainerName: row.trainer_name,
            originRegionId: row.origin_region_id,
            locale: row.locale,
            metadata: includeSensitive ? (row.profile_metadata ?? null) : null,
            revision: row.profile_revision,
          },
          identities: identitiesByPlayer.get(playerId) ?? [],
          onboarding: {
            state: row.onboarding_state,
            completedAt: isoNullable(row.onboarding_completed_at),
            revision: row.onboarding_revision,
            contentReleaseId: row.content_release_id,
            rulesetId: row.ruleset_id,
          },
          progression: {
            level: row.trainer_level,
            insigniaPoints: row.progression_points,
            revision: row.progression_revision,
            unlocks: unlocks.rows.map((entry) => ({
              key: entry.unlock_key,
              status: entry.status,
              sourceType: entry.source_type,
              sourceId: entry.source_id,
              unlockedAt: iso(entry.unlocked_at),
              revokedAt: isoNullable(entry.revoked_at),
              revision: entry.revision,
            })),
          },
          location:
            row.area_id === null || row.entered_at === null || row.location_revision === null
              ? null
              : {
                  areaId: row.area_id,
                  enteredAt: iso(row.entered_at),
                  revision: row.location_revision,
                },
          wallets: walletViews,
          inventory: inventoryViews,
          pokemon,
          pokedex: {
            speciesSeen: pokedexEntries.filter((entry) => BigInt(entry.seenCount) > 0n).length,
            speciesCaught: pokedexEntries.filter((entry) => BigInt(entry.caughtCount) > 0n).length,
            entries: pokedexEntries,
          },
          activeEncounter,
          activeBattle,
          effects,
          recentActivity,
          unsupportedSections: ["COOLDOWNS", "PUNISHMENTS_FLAGS"],
        };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }

  public async searchPlayers(query: Player360SearchQuery): Promise<{
    readonly items: readonly Player360SearchItemView[];
    readonly hasMore: boolean;
  }> {
    if (query.externalId !== null && !query.includeSensitive) {
      throw new Error("Sensitive identity lookup attempted without sensitive authorization");
    }

    return withTransaction(
      this.pool,
      async (client) => {
        const values: unknown[] = [];
        const conditions: string[] = [];

        const bind = (value: unknown): string => {
          values.push(value);
          return `$${values.length}`;
        };

        if (query.status !== null) {
          conditions.push(`player.status = ${bind(query.status)}`);
        }
        if (query.trainerNamePrefix !== null) {
          conditions.push(
            `lower(profile.trainer_name) LIKE lower(${bind(query.trainerNamePrefix)}) || '%'`,
          );
        }
        if (query.originRegionId !== null) {
          conditions.push(`profile.origin_region_id = ${bind(query.originRegionId)}::uuid`);
        }
        if (query.identityProvider !== null && query.externalId !== null) {
          const provider = bind(query.identityProvider);
          const externalId = bind(query.externalId);
          conditions.push(
            `EXISTS (
               SELECT 1 FROM player_identities identity_filter
               WHERE identity_filter.player_id = player.id
                 AND identity_filter.provider = ${provider}
                 AND identity_filter.external_id = ${externalId}
                 AND identity_filter.status = 'ACTIVE'
             )`,
          );
        }
        if (query.cursor !== null) {
          const createdAt = bind(query.cursor.createdAt);
          const playerId = bind(query.cursor.playerId);
          conditions.push(
            `(player.created_at, player.id) < (${createdAt}::timestamptz, ${playerId}::uuid)`,
          );
        }

        const limit = bind(query.limit + 1);
        const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
        const result = await client.query<SearchRow>(
          `SELECT player.id AS player_id, player.status,
                  profile.trainer_name, profile.origin_region_id,
                  progression.level AS trainer_level,
                  progression.progression_points::text,
                  location.area_id,
                  encounter.id AS active_encounter_id,
                  encounter.status AS active_encounter_status,
                  battle.id AS active_battle_id,
                  battle.status AS active_battle_status,
                  player.created_at
           FROM players player
           JOIN trainer_progression progression ON progression.player_id = player.id
           LEFT JOIN player_profiles profile ON profile.player_id = player.id
           LEFT JOIN player_locations location ON location.player_id = player.id
           LEFT JOIN encounters encounter
             ON encounter.player_id = player.id
            AND encounter.status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE')
           LEFT JOIN LATERAL (
             SELECT active.id, active.status
             FROM battles active
             JOIN battle_sides side ON side.battle_id = active.id
             WHERE side.player_id = player.id
               AND active.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
             ORDER BY active.created_at DESC, active.id DESC
             LIMIT 1
           ) battle ON TRUE
           ${where}
           ORDER BY player.created_at DESC, player.id DESC
           LIMIT ${limit}`,
          values,
        );

        const hasMore = result.rows.length > query.limit;
        const page = result.rows.slice(0, query.limit);
        const identities = await loadIdentities(
          client,
          page.map((entry) => entry.player_id),
          query.includeSensitive,
        );

        return {
          hasMore,
          items: page.map((entry) => ({
            playerId: entry.player_id,
            status: PlayerStatusSchema.parse(entry.status),
            trainerName: entry.trainer_name,
            originRegionId: entry.origin_region_id,
            trainerLevel: entry.trainer_level,
            insigniaPoints: entry.progression_points,
            areaId: entry.area_id,
            activeEncounterId: entry.active_encounter_id,
            activeEncounterStatus: entry.active_encounter_status,
            activeBattleId: entry.active_battle_id,
            activeBattleStatus: entry.active_battle_status,
            identities: identities.get(entry.player_id) ?? [],
            createdAt: iso(entry.created_at),
          })),
        };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
