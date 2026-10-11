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
import {
  type CompetitiveSpawnRewardDescriptor,
  competitiveSpawnBaseRewardKind,
  competitiveSpawnItemQuantity,
  competitiveSpawnMoneyAmount,
  competitiveSpawnPokemonBonusBasisPoints,
  competitiveSpawnPokemonBonusWon,
  competitiveSpawnProgressAmount,
} from "../../modules/competitive-spawn/reward.js";
import { WildPokemonSnapshotSchema } from "../../modules/encounter/snapshot-schema.js";
import { withTransaction } from "../db/transaction.js";
import { nextCanonicalRosterPlacement } from "../player/postgres-roster-placement.js";
import { recordPokedexSeen } from "../pokedex/postgres-pokedex-writer.js";

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
  readonly published_at: Date | null;
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
  type1_slug: string;
  type2_slug: string | null;
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
    type1Slug: row.type1_slug,
    type2Slug: row.type2_slug,
    weight,
    minLevel: row.min_level,
    maxLevel: row.max_level,
    areaId: row.area_id,
  };
}

interface ResolvedCompetitiveReward {
  readonly descriptor: CompetitiveSpawnRewardDescriptor;
  readonly pokemonBonus: boolean;
  readonly bonusBasisPoints: number;
}

async function resolveCompetitiveReward(
  client: PoolClient,
  spawn: CompetitiveSpawnRecord,
  input: {
    readonly rewardKindRoll: number;
    readonly rewardAmountRoll: number;
    readonly rewardItemRoll: number;
    readonly pokemonBonusRoll: number;
  },
): Promise<ResolvedCompetitiveReward> {
  const catchRateResult = await client.query<{ catch_rate: number | null }>(
    `SELECT catch_rate
     FROM pokemon_species_revisions
     WHERE content_release_id = $1
       AND species_id = $2
       AND active = TRUE`,
    [spawn.contentReleaseId, spawn.speciesId],
  );
  const catchRate = catchRateResult.rows[0]?.catch_rate ?? null;
  const bonusBasisPoints = competitiveSpawnPokemonBonusBasisPoints(catchRate);
  const pokemonBonus = competitiveSpawnPokemonBonusWon(catchRate, input.pokemonBonusRoll);

  const currency = await client.query<{ id: string; display_name: string }>(
    `SELECT currency.id, currency.display_name
     FROM item_purchase_offers offer
     JOIN currency_definitions currency ON currency.id = offer.currency_id
     WHERE offer.content_release_id = $1
       AND offer.active = TRUE
     GROUP BY currency.id, currency.display_name
     ORDER BY count(*) DESC, currency.display_name
     LIMIT 1`,
    [spawn.contentReleaseId],
  );

  const items = await client.query<{ item_id: string; display_name: string }>(
    `SELECT offer.item_id, revision.display_name
     FROM item_purchase_offers offer
     JOIN item_revisions revision
       ON revision.item_id = offer.item_id
      AND revision.content_release_id = offer.content_release_id
      AND revision.active = TRUE
     WHERE offer.content_release_id = $1
       AND offer.active = TRUE
     ORDER BY offer.sort_order, offer.price_amount, offer.offer_key
     LIMIT 16`,
    [spawn.contentReleaseId],
  );

  let kind = competitiveSpawnBaseRewardKind(input.rewardKindRoll);
  if (kind === "MONEY" && currency.rows[0] === undefined) kind = "PROGRESSION";
  if (kind === "ITEM" && items.rows.length === 0) {
    kind = currency.rows[0] === undefined ? "PROGRESSION" : "MONEY";
  }

  if (kind === "MONEY") {
    const selected = currency.rows[0];
    if (selected === undefined) throw new Error("Competitive money reward currency disappeared");
    const amount = competitiveSpawnMoneyAmount(catchRate);
    return {
      descriptor: {
        kind,
        amount,
        currencyId: selected.id,
        itemId: null,
        displayName: `${amount.toLocaleString("pt-BR")} ${selected.display_name}`,
      },
      pokemonBonus,
      bonusBasisPoints,
    };
  }

  if (kind === "ITEM") {
    const selected = items.rows[input.rewardItemRoll % items.rows.length];
    if (selected === undefined) throw new Error("Competitive item reward candidate disappeared");
    const amount = competitiveSpawnItemQuantity(input.rewardAmountRoll);
    return {
      descriptor: {
        kind,
        amount,
        currencyId: null,
        itemId: selected.item_id,
        displayName: `${amount}× ${selected.display_name}`,
      },
      pokemonBonus,
      bonusBasisPoints,
    };
  }

  const amount = competitiveSpawnProgressAmount(input.rewardAmountRoll);
  return {
    descriptor: {
      kind: "PROGRESSION",
      amount,
      currencyId: null,
      itemId: null,
      displayName: `+${amount} Insígnias`,
    },
    pokemonBonus,
    bonusBasisPoints,
  };
}

async function recordCompetitiveCaughtOnly(
  client: PoolClient,
  playerId: string,
  speciesId: string,
  shiny: boolean,
): Promise<void> {
  const updated = await client.query(
    `UPDATE player_pokedex_species
     SET caught_count = caught_count + 1,
         first_caught_at = COALESCE(first_caught_at, now()),
         last_caught_at = now(),
         shiny_caught_count = shiny_caught_count + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
         first_shiny_caught_at = CASE
           WHEN $3::boolean THEN COALESCE(first_shiny_caught_at, now())
           ELSE first_shiny_caught_at
         END,
         last_shiny_caught_at = CASE
           WHEN $3::boolean THEN now()
           ELSE last_shiny_caught_at
         END,
         revision = revision + 1
     WHERE player_id = $1 AND species_id = $2`,
    [playerId, speciesId, shiny],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw new Error("Competitive Pokemon bonus could not update caught history");
  }
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
       AND published_at IS NOT NULL
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
         ) AS open,
         (
           SELECT CASE
                    WHEN status = 'OPEN' THEN expires_at
                    ELSE COALESCE(resolved_at, published_at)
                  END
           FROM competitive_spawns
           WHERE community_group_id = $1
             AND published_at IS NOT NULL
           ORDER BY opened_at DESC
           LIMIT 1
         ) AS cooldown_anchor`,
      [groupId],
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

    // "Global" means regionally canonical: only species present in an active
    // encounter table for this content release. It is deliberately broader
    // than the player's current area, but never the whole Gen I-III Pokédex.
    const global = await this.pool.query<{
      form_id: string;
      species_id: string;
      national_dex: number;
      species_slug: string;
      display_name: string;
      type1_slug: string;
      type2_slug: string | null;
      weight: string;
      min_level: number;
      max_level: number;
      area_id: null;
    }>(
      `SELECT form.id AS form_id,
              species.id AS species_id,
              species.national_dex,
              species.slug AS species_slug,
              species_revision.display_name,
              type1.slug AS type1_slug,
              type2.slug AS type2_slug,
              SUM(entry.weight)::text AS weight,
              MIN(entry.min_level) AS min_level,
              MAX(entry.max_level) AS max_level,
              NULL::uuid AS area_id
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
       JOIN pokemon_types type1 ON type1.id = form_revision.type1_id
       LEFT JOIN pokemon_types type2 ON type2.id = form_revision.type2_id
       WHERE species.national_dex BETWEEN 1 AND 386
         AND form.slug = species.slug
       GROUP BY form.id, species.id, species.national_dex, species.slug,
                species_revision.display_name, type1.slug, type2.slug
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
        type1_slug: string;
        type2_slug: string | null;
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
                type1.slug AS type1_slug,
                type2.slug AS type2_slug,
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
         JOIN pokemon_types type1 ON type1.id = form_revision.type1_id
         LEFT JOIN pokemon_types type2 ON type2.id = form_revision.type2_id
         WHERE table_identity.area_id = $2
           AND species.national_dex BETWEEN 1 AND 386
           AND form.slug = species.slug
         GROUP BY form.id, species.id, species.national_dex, species.slug,
                  species_revision.display_name, type1.slug, type2.slug, table_identity.area_id
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

      const existing = await client.query<{ id: string }>(
        `SELECT id
         FROM competitive_spawns
         WHERE community_group_id = $1
           AND status = 'OPEN'
         LIMIT 1
         FOR UPDATE`,
        [input.communityGroupId],
      );
      if (existing.rows[0] !== undefined) return null;

      const recent = await client.query<{ cooldown_anchor: Date }>(
        `SELECT CASE
                  WHEN status = 'OPEN' THEN expires_at
                  ELSE COALESCE(resolved_at, opened_at)
                END AS cooldown_anchor
         FROM competitive_spawns
         WHERE community_group_id = $1
           AND published_at IS NOT NULL
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
                   pokemon_snapshot, render_spec, opened_at, published_at, expires_at, winner_player_id`,
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
      const row = inserted.rows[0];
      return row === undefined ? null : mapSpawn(row);
    });
  }

  public async consumeGuessBudget(input: {
    readonly spawnId: string;
    readonly playerId: string;
    readonly now: Date;
    readonly minIntervalMs: number;
    readonly maxAttempts: number;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.minIntervalMs) || input.minIntervalMs < 0) return false;
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) return false;
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `competitive-spawn-guess:${input.spawnId}:${input.playerId}`,
      ]);
      const current = await client.query<{
        accepted_count: number;
        last_accepted_at: Date | null;
      }>(
        `SELECT accepted_count, last_accepted_at
         FROM competitive_spawn_guess_budgets
         WHERE spawn_id = $1 AND player_id = $2
         FOR UPDATE`,
        [input.spawnId, input.playerId],
      );
      const row = current.rows[0];
      if (row !== undefined) {
        if (row.accepted_count >= input.maxAttempts) return false;
        if (
          row.last_accepted_at !== null &&
          input.now.getTime() - row.last_accepted_at.getTime() < input.minIntervalMs
        ) {
          return false;
        }
      }
      await client.query(
        `INSERT INTO competitive_spawn_guess_budgets(
           spawn_id, player_id, accepted_count, last_accepted_at, updated_at
         ) VALUES ($1, $2, 1, $3, $3)
         ON CONFLICT (spawn_id, player_id) DO UPDATE SET
           accepted_count = competitive_spawn_guess_budgets.accepted_count + 1,
           last_accepted_at = EXCLUDED.last_accepted_at,
           updated_at = EXCLUDED.updated_at`,
        [input.spawnId, input.playerId, input.now],
      );
      return true;
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
       WHERE spawn.id = $2 AND spawn.status = 'OPEN' AND spawn.published_at IS NOT NULL AND spawn.expires_at > now()
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
    readonly correlationId: string;
    readonly rewardKindRoll: number;
    readonly rewardAmountRoll: number;
    readonly rewardItemRoll: number;
    readonly pokemonBonusRoll: number;
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
        row.published_at === null ||
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

      // Every correct identification is a sighting, independently of the Pokemon bonus.
      await recordPokedexSeen(client, input.playerId, spawn.speciesId, spawn.shiny);

      const reward = await resolveCompetitiveReward(client, spawn, input);

      let pokemonInstanceId: string | null = null;
      let placement: {
        readonly placementKind: "TEAM" | "BOX";
        readonly boxNo: number | null;
        readonly slotNo: number;
      } | null = null;

      if (reward.pokemonBonus) {
        placement = await nextCanonicalRosterPlacement(client, input.playerId as never);
        pokemonInstanceId = randomUUID();

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

        // recordPokedexSeen already incremented seen_count above. Bonus only increments caught history.
        await recordCompetitiveCaughtOnly(client, input.playerId, spawn.speciesId, spawn.shiny);

        await client.query(
          `INSERT INTO pokemon_history_events(
             id, pokemon_instance_id, event_type, payload, actor_type, correlation_id
           ) VALUES ($1, $2, 'COMPETITIVE_SPAWN_CAPTURED', $3::jsonb, 'SYSTEM', $4)`,
          [
            randomUUID(),
            pokemonInstanceId,
            JSON.stringify({
              competitiveSpawnId: spawn.id,
              communityGroupId: spawn.communityGroupId,
              formId: spawn.formId,
              speciesId: spawn.speciesId,
            }),
            input.correlationId,
          ],
        );

        await client.query(
          `INSERT INTO competitive_spawn_grants(
             id, spawn_id, player_id, pokemon_instance_id,
             placement_kind, box_no, slot_no, idempotency_key
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            spawn.id,
            input.playerId,
            pokemonInstanceId,
            placement.placementKind,
            placement.boxNo,
            placement.slotNo,
            `${input.idempotencyKey}:pokemon-bonus`,
          ],
        );
      }

      await client.query(
        `INSERT INTO competitive_spawn_reward_intents(
           spawn_id, player_id, reward_kind, reward_amount, currency_id, item_id,
           display_name, correlation_id, pokemon_bonus, pokemon_bonus_basis_points,
           pokemon_bonus_roll, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          spawn.id,
          input.playerId,
          reward.descriptor.kind,
          reward.descriptor.amount,
          reward.descriptor.currencyId,
          reward.descriptor.itemId,
          reward.descriptor.displayName,
          input.correlationId,
          reward.pokemonBonus,
          reward.bonusBasisPoints,
          input.pokemonBonusRoll,
          `competitive-spawn:${spawn.id}:reward-intent`,
        ],
      );

      await client.query(
        `INSERT INTO competitive_spawn_reward_deliveries(spawn_id, next_attempt_at)
         VALUES ($1, $2)`,
        [spawn.id, input.now],
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
      if (won.rowCount !== 1) {
        throw new Error("Competitive spawn winner transition lost its row lock");
      }

      return {
        kind: "WON",
        spawn: { ...spawn, status: "WON", winnerPlayerId: input.playerId },
        pokemonInstanceId,
        placement,
        trainerName: player.trainer_name,
        reward: reward.descriptor,
        pokemonBonus: reward.pokemonBonus,
      };
    });
  }

  public async reconcilePublication(input: {
    readonly now: Date;
    readonly ttlMs: number;
    readonly orphanGraceMs: number;
    readonly limit: number;
  }): Promise<{ readonly published: number; readonly cancelled: number }> {
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("Competitive spawn publication TTL must be positive");
    }
    if (!Number.isSafeInteger(input.orphanGraceMs) || input.orphanGraceMs < 0) {
      throw new Error("Competitive spawn publication orphan grace must be non-negative");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      return { published: 0, cancelled: 0 };
    }

    return withTransaction(this.pool, async (client) => {
      const published = await client.query<{
        id: string;
        community_group_id: string;
        published_at: Date;
      }>(
        `WITH due AS (
           SELECT spawn.id, spawn.community_group_id, outbox.sent_at
           FROM competitive_spawns spawn
           JOIN outbox_messages outbox
             ON outbox.idempotency_key = 'competitive-spawn:' || spawn.id::text || ':image'
           WHERE spawn.status = 'OPEN'
             AND spawn.published_at IS NULL
             AND outbox.status = 'SENT'
             AND outbox.sent_at IS NOT NULL
           ORDER BY outbox.sent_at, spawn.id
           LIMIT $1
           FOR UPDATE OF spawn SKIP LOCKED
         )
         UPDATE competitive_spawns spawn
         SET published_at = due.sent_at,
             expires_at = due.sent_at + ($2::bigint * interval '1 millisecond')
         FROM due
         WHERE spawn.id = due.id
         RETURNING spawn.id, spawn.community_group_id, spawn.published_at`,
        [input.limit, input.ttlMs],
      );

      for (const spawn of published.rows) {
        await client.query(
          `UPDATE competitive_spawn_activity_state
           SET progress_milli = 0,
               target_roll = NULL,
               cycle_no = cycle_no + 1,
               last_activity_at = NULL,
               last_player_id = NULL,
               sender_streak = 0,
               updated_at = $2
           WHERE community_group_id = $1`,
          [spawn.community_group_id, spawn.published_at],
        );
      }

      const dead = await client.query<{ id: string }>(
        `WITH due AS (
           SELECT spawn.id
           FROM competitive_spawns spawn
           JOIN outbox_messages outbox
             ON outbox.idempotency_key = 'competitive-spawn:' || spawn.id::text || ':image'
           WHERE spawn.status = 'OPEN'
             AND spawn.published_at IS NULL
             AND outbox.status = 'DEAD'
           ORDER BY spawn.opened_at, spawn.id
           LIMIT $1
           FOR UPDATE OF spawn SKIP LOCKED
         )
         UPDATE competitive_spawns spawn
         SET status = 'CANCELLED',
             resolved_at = $2
         FROM due
         WHERE spawn.id = due.id
         RETURNING spawn.id`,
        [input.limit, input.now],
      );

      const orphanCutoff = new Date(input.now.getTime() - input.orphanGraceMs);
      const orphaned = await client.query<{ id: string }>(
        `WITH due AS (
           SELECT spawn.id
           FROM competitive_spawns spawn
           WHERE spawn.status = 'OPEN'
             AND spawn.published_at IS NULL
             AND spawn.opened_at <= $1
             AND NOT EXISTS (
               SELECT 1
               FROM outbox_messages outbox
               WHERE outbox.idempotency_key =
                 'competitive-spawn:' || spawn.id::text || ':image'
             )
           ORDER BY spawn.opened_at, spawn.id
           LIMIT $2
           FOR UPDATE OF spawn SKIP LOCKED
         )
         UPDATE competitive_spawns spawn
         SET status = 'CANCELLED',
             resolved_at = $3
         FROM due
         WHERE spawn.id = due.id
         RETURNING spawn.id`,
        [orphanCutoff, input.limit, input.now],
      );

      return {
        published: published.rows.length,
        cancelled: dead.rows.length + orphaned.rows.length,
      };
    });
  }

  public async expireDue(now: Date, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) return 0;
    return withTransaction(this.pool, async (client) => {
      const expired = await client.query<{ id: string; chat_ref: string }>(
        `WITH due AS (
           SELECT id
           FROM competitive_spawns
           WHERE status = 'OPEN' AND published_at IS NOT NULL AND expires_at <= $1
           ORDER BY expires_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE competitive_spawns spawn
         SET status = 'EXPIRED', resolved_at = spawn.expires_at
         FROM due
         WHERE spawn.id = due.id
         RETURNING spawn.id, spawn.chat_ref`,
        [now, limit],
      );

      for (const spawn of expired.rows) {
        await client.query(
          `INSERT INTO outbox_messages(
             id, channel, destination_ref, message_type, payload, idempotency_key,
             status, attempts, next_attempt_at, correlation_id, causation_id
           ) VALUES (
             $1, 'whatsapp', $2, 'TEXT', $3::jsonb, $4,
             'PENDING', 0, $5, $6, NULL
           )
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            randomUUID(),
            spawn.chat_ref,
            JSON.stringify({ text: "💨 O Pokémon selvagem fugiu!" }),
            `competitive-spawn:${spawn.id}:fled`,
            now,
            randomUUID(),
          ],
        );
      }
      return expired.rows.length;
    });
  }
}
