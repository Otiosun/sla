import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CompetitiveSpawnCandidate,
  CompetitiveSpawnCandidateContext,
  CompetitiveSpawnClaimResult,
  CompetitiveSpawnOpenWrite,
  CompetitiveSpawnRecord,
  CompetitiveSpawnRenderSpec,
  CompetitiveSpawnRepository,
} from "../../modules/competitive-spawn/contracts.js";
import { WildPokemonSnapshotSchema } from "../../modules/encounter/snapshot-schema.js";
import { withTransaction } from "../db/transaction.js";
import { nextCanonicalRosterPlacement } from "../player/postgres-roster-placement.js";
import { recordPokedexCaught } from "../pokedex/postgres-pokedex-writer.js";

interface SpawnRow {
  readonly id: string;
  readonly community_group_id: string;
  readonly provider: string;
  readonly chat_ref: string;
  readonly status: "OPEN" | "WON" | "EXPIRED" | "CANCELLED";
  readonly content_release_id: string;
  readonly ruleset_id: string;
  readonly area_id: string | null;
  readonly form_id: string;
  readonly species_id: string;
  readonly species_display_name: string;
  readonly normalized_answers: unknown;
  readonly national_dex: number;
  readonly level: number;
  readonly shiny: boolean;
  readonly pokemon_snapshot: unknown;
  readonly render_spec: unknown;
  readonly opened_at: Date;
  readonly expires_at: Date;
  readonly winner_player_id: string | null;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Competitive spawn answers are invalid");
  }
  return value as string[];
}

function renderSpec(value: unknown): CompetitiveSpawnRenderSpec {
  if (typeof value !== "object" || value === null) {
    throw new Error("Competitive spawn render spec is invalid");
  }
  const input = value as Record<string, unknown>;
  const bucket = input.timeBucket;
  if (
    input.schemaVersion !== 1 ||
    typeof input.backgroundUrl !== "string" ||
    typeof input.spriteUrl !== "string" ||
    typeof input.fallbackSpriteUrl !== "string" ||
    typeof input.centerX !== "number" ||
    typeof input.groundY !== "number" ||
    typeof input.maxSize !== "number" ||
    typeof input.floatY !== "number" ||
    typeof input.shadowOpacity !== "number" ||
    (bucket !== "MORNING" && bucket !== "DAY" && bucket !== "EVENING" && bucket !== "NIGHT")
  ) {
    throw new Error("Competitive spawn render spec is invalid");
  }
  return input as unknown as CompetitiveSpawnRenderSpec;
}

function mapSpawn(row: SpawnRow): CompetitiveSpawnRecord {
  const snapshot = WildPokemonSnapshotSchema.parse(row.pokemon_snapshot);
  return {
    id: row.id,
    communityGroupId: row.community_group_id,
    provider: row.provider,
    chatRef: row.chat_ref,
    status: row.status,
    contentReleaseId: row.content_release_id,
    rulesetId: row.ruleset_id,
    areaId: row.area_id,
    formId: row.form_id,
    speciesId: row.species_id,
    speciesDisplayName: row.species_display_name,
    normalizedAnswers: stringArray(row.normalized_answers),
    nationalDex: row.national_dex,
    level: row.level,
    shiny: row.shiny,
    snapshot,
    renderSpec: renderSpec(row.render_spec),
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    winnerPlayerId: row.winner_player_id,
  };
}

const SPAWN_SELECT = `
  SELECT id, community_group_id, provider, chat_ref, status,
         content_release_id, ruleset_id, area_id, form_id, species_id,
         species_display_name, normalized_answers, national_dex, level, shiny,
         pokemon_snapshot, render_spec, opened_at, expires_at, winner_player_id
  FROM competitive_spawns
`;

function mapCandidate(row: {
  form_id: string;
  species_id: string;
  national_dex: number;
  species_slug: string;
  display_name: string;
  weight: string | number;
  min_level: number;
  max_level: number;
  area_id: string | null;
}): CompetitiveSpawnCandidate {
  const weight = Number(row.weight);
  if (!Number.isSafeInteger(weight) || weight <= 0) {
    throw new Error("Competitive spawn candidate has invalid weight");
  }
  return {
    formId: row.form_id,
    speciesId: row.species_id,
    nationalDex: row.national_dex,
    speciesSlug: row.species_slug,
    displayName: row.display_name,
    weight,
    minLevel: row.min_level,
    maxLevel: row.max_level,
    areaId: row.area_id,
  };
}

async function activeForGroupClient(
  client: PoolClient,
  groupId: string,
  lock = false,
): Promise<CompetitiveSpawnRecord | null> {
  const result = await client.query<SpawnRow>(
    `${SPAWN_SELECT}
     WHERE community_group_id = $1
       AND status = 'OPEN'
       AND expires_at > now()
     ORDER BY opened_at DESC
     LIMIT 1
     ${lock ? "FOR UPDATE" : ""}`,
    [groupId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapSpawn(row);
}

export class PostgresCompetitiveSpawnRepository implements CompetitiveSpawnRepository {
  public constructor(private readonly pool: Pool) {}

  public async activeForGroup(groupId: string): Promise<CompetitiveSpawnRecord | null> {
    const client = await this.pool.connect();
    try {
      return await activeForGroupClient(client, groupId);
    } finally {
      client.release();
    }
  }

  public async canOpen(groupId: string, now: Date, cooldownMs: number): Promise<boolean> {
    const result = await this.pool.query<{ open: boolean; cooldown_anchor: Date | null }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM competitive_spawns
           WHERE community_group_id = $1
             AND status = 'OPEN'
             AND expires_at > $2
         ) AS open,
         (
           SELECT CASE
                    WHEN status = 'OPEN' THEN expires_at
                    ELSE COALESCE(resolved_at, opened_at)
                  END
           FROM competitive_spawns
           WHERE community_group_id = $1
           ORDER BY opened_at DESC
           LIMIT 1
         ) AS cooldown_anchor`,
      [groupId, now],
    );
    const row = result.rows[0];
    if (row === undefined || row.open) return false;
    if (row.cooldown_anchor === null) return true;
    return now.getTime() - row.cooldown_anchor.getTime() >= cooldownMs;
  }

  public async candidateContext(
    playerId: string | null,
  ): Promise<CompetitiveSpawnCandidateContext | null> {
    const active = await this.pool.query<{ content_release_id: string; ruleset_id: string }>(
      `SELECT release.id AS content_release_id, release.default_ruleset_id AS ruleset_id
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id = pointer.content_release_id
       WHERE pointer.pointer_key = 'ACTIVE' AND release.status = 'PUBLISHED'`,
    );
    const activeRow = active.rows[0];
    if (activeRow === undefined) return null;

    let areaId: string | null = null;
    if (playerId !== null) {
      const location = await this.pool.query<{ area_id: string }>(
        "SELECT area_id FROM player_locations WHERE player_id = $1",
        [playerId],
      );
      areaId = location.rows[0]?.area_id ?? null;
    }

    const global = await this.pool.query<{
      form_id: string;
      species_id: string;
      national_dex: number;
      species_slug: string;
      display_name: string;
      weight: number;
      min_level: number;
      max_level: number;
      area_id: null;
    }>(
      `SELECT form.id AS form_id,
              species.id AS species_id,
              species.national_dex,
              species.slug AS species_slug,
              species_revision.display_name,
              1 AS weight,
              1 AS min_level,
              50 AS max_level,
              NULL::uuid AS area_id
       FROM pokemon_species species
       JOIN pokemon_species_revisions species_revision
         ON species_revision.species_id = species.id
        AND species_revision.content_release_id = $1
        AND species_revision.active = TRUE
       JOIN pokemon_forms form
         ON form.species_id = species.id
        AND form.slug = species.slug
       JOIN pokemon_form_revisions form_revision
         ON form_revision.form_id = form.id
        AND form_revision.content_release_id = $1
        AND form_revision.active = TRUE
       WHERE species.national_dex BETWEEN 1 AND 386
       ORDER BY species.national_dex`,
      [activeRow.content_release_id],
    );

    let localCandidates: CompetitiveSpawnCandidate[] = [];
    if (areaId !== null) {
      const local = await this.pool.query<{
        form_id: string;
        species_id: string;
        national_dex: number;
        species_slug: string;
        display_name: string;
        weight: string;
        min_level: number;
        max_level: number;
        area_id: string;
      }>(
        `SELECT form.id AS form_id,
                species.id AS species_id,
                species.national_dex,
                species.slug AS species_slug,
                species_revision.display_name,
                SUM(entry.weight)::text AS weight,
                MIN(entry.min_level) AS min_level,
                MAX(entry.max_level) AS max_level,
                table_identity.area_id
         FROM encounter_tables table_identity
         JOIN encounter_table_revisions table_revision
           ON table_revision.encounter_table_id = table_identity.id
          AND table_revision.content_release_id = $1
          AND table_revision.active = TRUE
         JOIN encounter_entries entry
           ON entry.encounter_table_revision_id = table_revision.id
          AND entry.active = TRUE
         JOIN pokemon_forms form ON form.id = entry.form_id
         JOIN pokemon_species species ON species.id = form.species_id
         JOIN pokemon_species_revisions species_revision
           ON species_revision.species_id = species.id
          AND species_revision.content_release_id = $1
          AND species_revision.active = TRUE
         JOIN pokemon_form_revisions form_revision
           ON form_revision.form_id = form.id
          AND form_revision.content_release_id = $1
          AND form_revision.active = TRUE
         WHERE table_identity.area_id = $2
           AND species.national_dex BETWEEN 1 AND 386
           AND form.slug = species.slug
         GROUP BY form.id, species.id, species.national_dex, species.slug,
                  species_revision.display_name, table_identity.area_id
         ORDER BY species.national_dex`,
        [activeRow.content_release_id, areaId],
      );
      localCandidates = local.rows.map(mapCandidate);
    }

    return {
      contentReleaseId: activeRow.content_release_id,
      rulesetId: activeRow.ruleset_id,
      playerAreaId: areaId,
      localCandidates,
      globalCandidates: global.rows.map(mapCandidate),
    };
  }

  public async createOpen(
    input: CompetitiveSpawnOpenWrite,
    cooldownMs: number,
  ): Promise<CompetitiveSpawnRecord | null> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `competitive-spawn:${input.communityGroupId}`,
      ]);

      await client.query(
        `UPDATE competitive_spawns
         SET status = 'EXPIRED',
             resolved_at = expires_at
         WHERE community_group_id = $1
           AND status = 'OPEN'
           AND expires_at <= $2`,
        [input.communityGroupId, input.openedAt],
      );

      const existing = await activeForGroupClient(client, input.communityGroupId, true);
      if (existing !== null) return null;

      const recent = await client.query<{ cooldown_anchor: Date }>(
        `SELECT CASE
                  WHEN status = 'OPEN' THEN expires_at
                  ELSE COALESCE(resolved_at, opened_at)
                END AS cooldown_anchor
         FROM competitive_spawns
         WHERE community_group_id = $1
         ORDER BY opened_at DESC
         LIMIT 1`,
        [input.communityGroupId],
      );
      const last = recent.rows[0]?.cooldown_anchor;
      if (last !== undefined && input.openedAt.getTime() - last.getTime() < cooldownMs) return null;

      const inserted = await client.query<SpawnRow>(
        `INSERT INTO competitive_spawns(
           id, community_group_id, provider, chat_ref, status, outcome_kind,
           content_release_id, ruleset_id, area_id, form_id, species_id,
           species_display_name, normalized_answers, national_dex, level, shiny,
           pokemon_snapshot, render_spec, creation_idempotency_key, opened_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, 'OPEN', 'POKEMON',
           $5, $6, $7, $8, $9,
           $10, $11::jsonb, $12, $13, $14,
           $15::jsonb, $16::jsonb, $17, $18, $19
         )
         RETURNING id, community_group_id, provider, chat_ref, status,
                   content_release_id, ruleset_id, area_id, form_id, species_id,
                   species_display_name, normalized_answers, national_dex, level, shiny,
                   pokemon_snapshot, render_spec, opened_at, expires_at, winner_player_id`,
        [
          input.id,
          input.communityGroupId,
          input.provider,
          input.chatRef,
          input.contentReleaseId,
          input.rulesetId,
          input.areaId,
          input.formId,
          input.speciesId,
          input.speciesDisplayName,
          JSON.stringify(input.normalizedAnswers),
          input.nationalDex,
          input.level,
          input.shiny,
          JSON.stringify(input.snapshot),
          JSON.stringify(input.renderSpec),
          input.creationIdempotencyKey,
          input.openedAt,
          input.expiresAt,
        ],
      );
      await client.query(
        `INSERT INTO competitive_spawn_activity_state(
           community_group_id, progress_milli, target_roll, cycle_no,
           last_activity_at, last_player_id, sender_streak, updated_at
         ) VALUES ($1, 0, NULL, 1, NULL, NULL, 0, $2)
         ON CONFLICT (community_group_id) DO UPDATE SET
           progress_milli = 0,
           target_roll = NULL,
           cycle_no = competitive_spawn_activity_state.cycle_no + 1,
           last_activity_at = NULL,
           last_player_id = NULL,
           sender_streak = 0,
           updated_at = EXCLUDED.updated_at`,
        [input.communityGroupId, input.openedAt],
      );

      const row = inserted.rows[0];
      return row === undefined ? null : mapSpawn(row);
    });
  }

  public async recordWrongGuess(input: {
    readonly spawnId: string;
    readonly inboxMessageId: string;
    readonly playerId: string;
    readonly senderRef: string;
    readonly normalizedGuess: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO competitive_spawn_attempts(
         id, spawn_id, inbox_message_id, player_id, sender_ref, normalized_guess, correct
       )
       SELECT $1, spawn.id, $3, $4, $5, $6, FALSE
       FROM competitive_spawns spawn
       WHERE spawn.id = $2 AND spawn.status = 'OPEN' AND spawn.expires_at > now()
       ON CONFLICT (inbox_message_id) DO NOTHING`,
      [
        randomUUID(),
        input.spawnId,
        input.inboxMessageId,
        input.playerId,
        input.senderRef,
        input.normalizedGuess,
      ],
    );
  }

  public async claimCorrect(input: {
    readonly spawnId: string;
    readonly inboxMessageId: string;
    readonly playerId: string;
    readonly senderRef: string;
    readonly normalizedGuess: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<CompetitiveSpawnClaimResult> {
    return withTransaction(this.pool, async (client) => {
      const rowResult = await client.query<SpawnRow>(`${SPAWN_SELECT} WHERE id = $1 FOR UPDATE`, [
        input.spawnId,
      ]);
      const row = rowResult.rows[0];
      if (
        row === undefined ||
        row.status !== "OPEN" ||
        row.expires_at.getTime() <= input.now.getTime()
      ) {
        return { kind: "CLOSED" };
      }
      const spawn = mapSpawn(row);

      const duplicate = await client.query<{ id: string }>(
        "SELECT id FROM competitive_spawn_attempts WHERE inbox_message_id = $1",
        [input.inboxMessageId],
      );
      if (duplicate.rows[0] !== undefined) return { kind: "REPLAYED" };

      const eligible = await client.query<{ trainer_name: string | null }>(
        `SELECT profile.trainer_name
         FROM players player
         JOIN onboarding_states onboarding ON onboarding.player_id = player.id
         LEFT JOIN player_profiles profile ON profile.player_id = player.id
         WHERE player.id = $1
           AND player.status = 'ACTIVE'
           AND onboarding.state = 'COMPLETE'
         FOR UPDATE OF player`,
        [input.playerId],
      );
      const player = eligible.rows[0];
      if (player === undefined) return { kind: "PLAYER_INELIGIBLE" };

      await client.query(
        `INSERT INTO competitive_spawn_attempts(
           id, spawn_id, inbox_message_id, player_id, sender_ref, normalized_guess, correct
         ) VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
        [
          randomUUID(),
          spawn.id,
          input.inboxMessageId,
          input.playerId,
          input.senderRef,
          input.normalizedGuess,
        ],
      );

      const placement = await nextCanonicalRosterPlacement(client, input.playerId as never);
      const pokemonInstanceId = randomUUID();
      const grantId = randomUUID();

      await client.query(
        `INSERT INTO pokemon_instances(
           id, owner_player_id, form_id, level, current_hp, gender, shiny,
           ability_id, origin_type, origin_id, captured_at, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, 'COMPETITIVE_SPAWN', $9, $10, $11::jsonb
         )`,
        [
          pokemonInstanceId,
          input.playerId,
          spawn.formId,
          spawn.snapshot.level,
          spawn.snapshot.currentHp,
          spawn.snapshot.gender,
          spawn.snapshot.shiny,
          spawn.snapshot.abilityId,
          spawn.id,
          input.now,
          JSON.stringify({ competitiveSpawnId: spawn.id }),
        ],
      );

      await client.query(
        `INSERT INTO pokemon_training_values(
           pokemon_instance_id, nature_id, iv_hp, iv_attack, iv_defense,
           iv_sp_attack, iv_sp_defense, iv_speed
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          pokemonInstanceId,
          spawn.snapshot.natureId,
          spawn.snapshot.ivs.hp,
          spawn.snapshot.ivs.attack,
          spawn.snapshot.ivs.defense,
          spawn.snapshot.ivs.spAttack,
          spawn.snapshot.ivs.spDefense,
          spawn.snapshot.ivs.speed,
        ],
      );

      for (const [index, move] of spawn.snapshot.moves.entries()) {
        await client.query(
          `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
           VALUES ($1, $2, $3, $4)`,
          [pokemonInstanceId, index + 1, move.moveId, move.ppCurrent],
        );
      }

      await client.query(
        `INSERT INTO pokemon_roster_slots(
           pokemon_instance_id, player_id, placement_kind, box_no, slot_no
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          pokemonInstanceId,
          input.playerId,
          placement.placementKind,
          placement.boxNo,
          placement.slotNo,
        ],
      );

      await recordPokedexCaught(client, input.playerId, spawn.speciesId, spawn.shiny);

      await client.query(
        `INSERT INTO pokemon_history_events(
           id, pokemon_instance_id, event_type, payload, actor_type, correlation_id
         ) VALUES ($1, $2, 'COMPETITIVE_SPAWN_CAPTURED', $3::jsonb, 'SYSTEM', NULL)`,
        [
          randomUUID(),
          pokemonInstanceId,
          JSON.stringify({
            competitiveSpawnId: spawn.id,
            communityGroupId: spawn.communityGroupId,
            formId: spawn.formId,
            speciesId: spawn.speciesId,
          }),
        ],
      );

      await client.query(
        `INSERT INTO competitive_spawn_grants(
           id, spawn_id, player_id, pokemon_instance_id,
           placement_kind, box_no, slot_no, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          grantId,
          spawn.id,
          input.playerId,
          pokemonInstanceId,
          placement.placementKind,
          placement.boxNo,
          placement.slotNo,
          input.idempotencyKey,
        ],
      );

      const won = await client.query(
        `UPDATE competitive_spawns
         SET status = 'WON',
             winner_player_id = $2,
             winning_inbox_message_id = $3,
             resolved_at = $4
         WHERE id = $1 AND status = 'OPEN'`,
        [spawn.id, input.playerId, input.inboxMessageId, input.now],
      );
      if (won.rowCount !== 1)
        throw new Error("Competitive spawn winner transition lost its row lock");

      return {
        kind: "WON",
        spawn: { ...spawn, status: "WON", winnerPlayerId: input.playerId },
        pokemonInstanceId,
        placement,
        trainerName: player.trainer_name,
      };
    });
  }

  public async expireDue(now: Date, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) return 0;
    const result = await this.pool.query(
      `WITH due AS (
         SELECT id
         FROM competitive_spawns
         WHERE status = 'OPEN' AND expires_at <= $1
         ORDER BY expires_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE competitive_spawns spawn
       SET status = 'EXPIRED', resolved_at = spawn.expires_at
       FROM due
       WHERE spawn.id = due.id`,
      [now, limit],
    );
    return result.rowCount ?? 0;
  }
}
