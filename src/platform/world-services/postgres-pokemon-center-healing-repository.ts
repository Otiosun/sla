import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RulesetConfigSchema } from "../../modules/catalog/contracts.js";
import { calculatePokemonStats } from "../../modules/pokemon/stats.js";
import type {
  HealPokemonCenterTeamInput,
  PokemonCenterHealingChanges,
  PokemonCenterHealingPersistenceResult,
  PokemonCenterHealingRepository,
} from "../../modules/world-services/healing-service.js";
import { withTransaction } from "../db/transaction.js";

interface HealingClaimRow {
  readonly player_id: string;
  readonly session_id: string;
  readonly healed_pokemon_count: number;
  readonly hp_restored_pokemon_count: number;
  readonly pp_restored_slots: number;
  readonly statuses_cleared: number;
}

interface TeamPokemonRow {
  readonly pokemon_instance_id: string;
  readonly level: number;
  readonly current_hp: number;
  readonly base_hp: number;
  readonly base_attack: number;
  readonly base_defense: number;
  readonly base_sp_attack: number;
  readonly base_sp_defense: number;
  readonly base_speed: number;
  readonly iv_hp: number | null;
  readonly iv_attack: number | null;
  readonly iv_defense: number | null;
  readonly iv_sp_attack: number | null;
  readonly iv_sp_defense: number | null;
  readonly iv_speed: number | null;
  readonly increased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  readonly decreased_stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
}

interface MoveSlotRow {
  readonly pokemon_instance_id: string;
  readonly slot_no: number;
  readonly pp_current: number | null;
  readonly max_pp: number | null;
}

function changesFromClaim(row: HealingClaimRow): PokemonCenterHealingChanges {
  return {
    healedPokemonCount: row.healed_pokemon_count,
    hpRestoredPokemonCount: row.hp_restored_pokemon_count,
    ppRestoredSlots: row.pp_restored_slots,
    statusesCleared: row.statuses_cleared,
  };
}

async function activeContent(client: PoolClient): Promise<{
  readonly contentReleaseId: string;
  readonly rulesetConfig: unknown;
} | null> {
  const result = await client.query<{
    content_release_id: string;
    ruleset_config: unknown;
  }>(
    `SELECT release.id AS content_release_id, ruleset.config AS ruleset_config
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
    : { contentReleaseId: row.content_release_id, rulesetConfig: row.ruleset_config };
}

async function lockedTeam(
  client: PoolClient,
  playerId: string,
  contentReleaseId: string,
): Promise<readonly TeamPokemonRow[]> {
  const result = await client.query<TeamPokemonRow>(
    `SELECT pi.id AS pokemon_instance_id, pi.level, pi.current_hp,
            revision.base_hp, revision.base_attack, revision.base_defense,
            revision.base_sp_attack, revision.base_sp_defense, revision.base_speed,
            training.iv_hp, training.iv_attack, training.iv_defense,
            training.iv_sp_attack, training.iv_sp_defense, training.iv_speed,
            nature.increased_stat, nature.decreased_stat
     FROM pokemon_roster_slots roster
     JOIN pokemon_instances pi
       ON pi.id = roster.pokemon_instance_id
      AND pi.owner_player_id = roster.player_id
     JOIN pokemon_form_revisions revision
       ON revision.form_id = pi.form_id
      AND revision.content_release_id = $2
     LEFT JOIN pokemon_training_values training
       ON training.pokemon_instance_id = pi.id
     LEFT JOIN nature_revisions nature
       ON nature.nature_id = training.nature_id
      AND nature.content_release_id = $2
     WHERE roster.player_id = $1
       AND roster.placement_kind = 'TEAM'
       AND pi.status = 'ACTIVE'
       AND revision.active = TRUE
     ORDER BY roster.slot_no
     FOR UPDATE OF pi`,
    [playerId, contentReleaseId],
  );
  return result.rows;
}

async function teamMoves(
  client: PoolClient,
  pokemonInstanceIds: readonly string[],
  contentReleaseId: string,
): Promise<readonly MoveSlotRow[]> {
  const result = await client.query<MoveSlotRow>(
    `SELECT slots.pokemon_instance_id, slots.slot_no, slots.pp_current, revision.max_pp
     FROM pokemon_move_slots slots
     LEFT JOIN move_revisions revision
       ON revision.move_id = slots.move_id
      AND revision.content_release_id = $2
      AND revision.active = TRUE
     WHERE slots.pokemon_instance_id = ANY($1::uuid[])
     ORDER BY slots.pokemon_instance_id, slots.slot_no
     FOR UPDATE OF slots`,
    [pokemonInstanceIds, contentReleaseId],
  );
  return result.rows;
}

export class PostgresPokemonCenterHealingRepository implements PokemonCenterHealingRepository {
  public constructor(private readonly pool: Pool) {}

  public async healTeam(
    input: HealPokemonCenterTeamInput,
  ): Promise<PokemonCenterHealingPersistenceResult> {
    return withTransaction(
      this.pool,
      async (client) => {
        const player = await client.query<{ id: string }>(
          "SELECT id FROM players WHERE id = $1 FOR UPDATE",
          [input.playerId],
        );
        if (player.rows[0] === undefined) {
          return { kind: "INVALID_STATE", reason: "Player was not found" };
        }

        const session = await client.query<{ id: string }>(
          `SELECT id
           FROM world_service_sessions
           WHERE id = $1
             AND player_id = $2
             AND service_kind = 'POKEMON_CENTER'
             AND state = 'OPEN'
             AND closed_at IS NULL
           FOR UPDATE`,
          [input.sessionId, input.playerId],
        );
        if (session.rows[0] === undefined) return { kind: "CENTER_VISIT_REQUIRED" };

        const source = await client.query<{ id: string }>(
          `SELECT id
           FROM inbox_messages
           WHERE id = $1 AND player_id = $2`,
          [input.sourceInboxMessageId, input.playerId],
        );
        if (source.rows[0] === undefined) {
          return {
            kind: "INVALID_STATE",
            reason: "Healing source message does not belong to the player",
          };
        }

        const activeBattle = await client.query<{ active: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM battle_sides side
             JOIN battles battle ON battle.id = side.battle_id
             WHERE side.player_id = $1
               AND battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
           ) AS active`,
          [input.playerId],
        );
        if (activeBattle.rows[0]?.active === true) return { kind: "ACTIVE_BATTLE" };

        const activeEncounter = await client.query<{ active: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM encounters
             WHERE player_id = $1
               AND status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE')
           ) AS active`,
          [input.playerId],
        );
        if (activeEncounter.rows[0]?.active === true) return { kind: "ACTIVE_ENCOUNTER" };

        const existingClaim = await client.query<HealingClaimRow>(
          `SELECT player_id, session_id,
                  healed_pokemon_count, hp_restored_pokemon_count,
                  pp_restored_slots, statuses_cleared
           FROM pokemon_center_healing_claims
           WHERE source_inbox_message_id = $1
           FOR UPDATE`,
          [input.sourceInboxMessageId],
        );
        const existing = existingClaim.rows[0];
        if (existing !== undefined) {
          if (existing.player_id !== input.playerId || existing.session_id !== input.sessionId) {
            return {
              kind: "INVALID_STATE",
              reason: "Healing replay identity does not match the committed claim",
            };
          }
          return { kind: "REPLAYED", result: changesFromClaim(existing) };
        }

        const content = await activeContent(client);
        if (content === null) {
          return { kind: "INVALID_STATE", reason: "Active published content is unavailable" };
        }
        const parsedRuleset = RulesetConfigSchema.safeParse(content.rulesetConfig);
        if (!parsedRuleset.success) {
          return { kind: "INVALID_STATE", reason: "Active ruleset configuration is invalid" };
        }

        const team = await lockedTeam(client, input.playerId, content.contentReleaseId);
        if (team.length === 0) {
          return { kind: "INVALID_STATE", reason: "Active Pokémon team is empty" };
        }

        const maxHpByPokemon = new Map<string, number>();
        const hpRestored = new Set<string>();
        for (const pokemon of team) {
          const stats = calculatePokemonStats({
            baseStats: {
              hp: pokemon.base_hp,
              attack: pokemon.base_attack,
              defense: pokemon.base_defense,
              spAttack: pokemon.base_sp_attack,
              spDefense: pokemon.base_sp_defense,
              speed: pokemon.base_speed,
            },
            ivs: {
              hp: pokemon.iv_hp ?? 0,
              attack: pokemon.iv_attack ?? 0,
              defense: pokemon.iv_defense ?? 0,
              spAttack: pokemon.iv_sp_attack ?? 0,
              spDefense: pokemon.iv_sp_defense ?? 0,
              speed: pokemon.iv_speed ?? 0,
            },
            level: pokemon.level,
            nature: {
              increasedStat: pokemon.increased_stat,
              decreasedStat: pokemon.decreased_stat,
            },
            ivEnabled: parsedRuleset.data.battle.ivEnabled,
            natureEnabled: parsedRuleset.data.battle.natureEnabled,
          });
          maxHpByPokemon.set(pokemon.pokemon_instance_id, stats.hp);
          if (pokemon.current_hp !== stats.hp) hpRestored.add(pokemon.pokemon_instance_id);
        }

        const pokemonIds = team.map((pokemon) => pokemon.pokemon_instance_id);
        const moves = await teamMoves(client, pokemonIds, content.contentReleaseId);
        const ppRestoredByPokemon = new Map<string, number>();
        let ppRestoredSlots = 0;
        if (parsedRuleset.data.battle.ppEnabled) {
          for (const move of moves) {
            if (move.max_pp === null) {
              return {
                kind: "INVALID_STATE",
                reason: "A team move is missing published maximum PP",
              };
            }
            if (move.pp_current === move.max_pp) continue;
            const updated = await client.query(
              `UPDATE pokemon_move_slots
               SET pp_current = $3
               WHERE pokemon_instance_id = $1 AND slot_no = $2`,
              [move.pokemon_instance_id, move.slot_no, move.max_pp],
            );
            if (updated.rowCount !== 1) {
              throw new Error("Pokemon Center PP recovery lost a locked move slot");
            }
            ppRestoredSlots += 1;
            ppRestoredByPokemon.set(
              move.pokemon_instance_id,
              (ppRestoredByPokemon.get(move.pokemon_instance_id) ?? 0) + 1,
            );
          }
        }

        const deletedConditions = await client.query<{ pokemon_instance_id: string }>(
          `DELETE FROM pokemon_persistent_conditions
           WHERE pokemon_instance_id = ANY($1::uuid[])
           RETURNING pokemon_instance_id`,
          [pokemonIds],
        );
        const statusesClearedByPokemon = new Map<string, number>();
        for (const condition of deletedConditions.rows) {
          statusesClearedByPokemon.set(
            condition.pokemon_instance_id,
            (statusesClearedByPokemon.get(condition.pokemon_instance_id) ?? 0) + 1,
          );
        }

        const mutatedPokemon = new Set<string>(hpRestored);
        for (const pokemonId of ppRestoredByPokemon.keys()) mutatedPokemon.add(pokemonId);
        for (const pokemonId of statusesClearedByPokemon.keys()) mutatedPokemon.add(pokemonId);

        for (const pokemonId of mutatedPokemon) {
          const maximumHp = maxHpByPokemon.get(pokemonId);
          if (maximumHp === undefined) {
            throw new Error("Pokemon Center recovery lost a locked team Pokemon");
          }
          const updated = await client.query(
            `UPDATE pokemon_instances
             SET current_hp = $2,
                 revision = revision + 1,
                 updated_at = now()
             WHERE id = $1 AND owner_player_id = $3`,
            [pokemonId, maximumHp, input.playerId],
          );
          if (updated.rowCount !== 1) {
            throw new Error("Pokemon Center recovery lost a locked team Pokemon");
          }
          await client.query(
            `INSERT INTO pokemon_history_events(
               id, pokemon_instance_id, event_type, payload,
               actor_type, actor_id, correlation_id
             ) VALUES ($1, $2, 'POKEMON_CENTER_HEALED', $3::jsonb, 'SYSTEM', NULL, $4)`,
            [
              randomUUID(),
              pokemonId,
              JSON.stringify({
                schemaVersion: 1,
                hpRestored: hpRestored.has(pokemonId),
                ppRestoredSlots: ppRestoredByPokemon.get(pokemonId) ?? 0,
                statusesCleared: statusesClearedByPokemon.get(pokemonId) ?? 0,
              }),
              input.correlationId,
            ],
          );
        }

        const changes: PokemonCenterHealingChanges = {
          healedPokemonCount: mutatedPokemon.size,
          hpRestoredPokemonCount: hpRestored.size,
          ppRestoredSlots,
          statusesCleared: deletedConditions.rowCount ?? deletedConditions.rows.length,
        };
        await client.query(
          `INSERT INTO pokemon_center_healing_claims(
             source_inbox_message_id, player_id, session_id,
             healed_pokemon_count, hp_restored_pokemon_count,
             pp_restored_slots, statuses_cleared, correlation_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.sourceInboxMessageId,
            input.playerId,
            input.sessionId,
            changes.healedPokemonCount,
            changes.hpRestoredPokemonCount,
            changes.ppRestoredSlots,
            changes.statusesCleared,
            input.correlationId,
          ],
        );
        return { kind: "APPLIED", result: changes };
      },
      { isolationLevel: "READ COMMITTED" },
    );
  }
}
