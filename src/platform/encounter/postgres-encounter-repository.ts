import type { Pool, PoolClient } from "pg";
import { parseEncounterConditions } from "../../modules/catalog/encounter-contracts.js";
import type {
  EncounterPlayerContext,
  EncounterRecord,
  EncounterTableRecord,
  WildPokemonBuild,
  WildPokemonSnapshot,
} from "../../modules/encounter/contracts.js";
import { EncounterStatusSchema } from "../../modules/encounter/contracts.js";
import type {
  ActiveEncounterContent,
  EncounterRepository,
  EncounterTransaction,
} from "../../modules/encounter/ports.js";
import { WildPokemonSnapshotSchema } from "../../modules/encounter/snapshot-schema.js";
import {
  type EncounterId,
  type PlayerId,
  parseEncounterId,
  parsePlayerId,
} from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";
import { recordPokedexSeen } from "../pokedex/postgres-pokedex-writer.js";

interface EncounterRow {
  readonly id: string;
  readonly player_id: string;
  readonly area_id: string;
  readonly status: string;
  readonly content_release_id: string;
  readonly ruleset_id: string;
  readonly creation_idempotency_key: string;
  readonly rng_counter: string;
  readonly revision: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly expires_at: Date | null;
  readonly closed_at: Date | null;
}

function toPlayerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function toEncounterId(value: string): EncounterId {
  const parsed = parseEncounterId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid EncounterId");
  return parsed.value;
}

function mapEncounter(row: EncounterRow): EncounterRecord {
  return {
    encounterId: toEncounterId(row.id),
    playerId: toPlayerId(row.player_id),
    areaId: row.area_id,
    status: EncounterStatusSchema.parse(row.status),
    contentReleaseId: row.content_release_id,
    rulesetId: row.ruleset_id,
    creationIdempotencyKey: row.creation_idempotency_key,
    rngCounter: BigInt(row.rng_counter),
    revision: BigInt(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
  };
}

const ENCOUNTER_SELECT = `
  SELECT id, player_id, area_id, status, content_release_id, ruleset_id,
         creation_idempotency_key, rng_counter::text, revision::text,
         created_at, updated_at, expires_at, closed_at
  FROM encounters
`;

class PostgresEncounterTransaction implements EncounterTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async activeContent(): Promise<ActiveEncounterContent | null> {
    const result = await this.client.query<{
      content_release_id: string;
      ruleset_id: string;
      ruleset_config: unknown;
    }>(
      `SELECT release.id AS content_release_id,
              ruleset.id AS ruleset_id,
              ruleset.config AS ruleset_config
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
      : {
          contentReleaseId: row.content_release_id,
          rulesetId: row.ruleset_id,
          rulesetConfig: row.ruleset_config,
        };
  }

  public async rulesetConfig(rulesetId: string): Promise<unknown | null> {
    const result = await this.client.query<{ config: unknown }>(
      "SELECT config FROM rulesets WHERE id = $1 AND status IN ('PUBLISHED', 'ARCHIVED')",
      [rulesetId],
    );
    return result.rows[0]?.config ?? null;
  }

  public async playerContext(
    playerId: PlayerId,
    lock = false,
  ): Promise<EncounterPlayerContext | null> {
    const player = await this.client.query<{ status: string }>(
      `SELECT status FROM players WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
      [playerId],
    );
    const playerRow = player.rows[0];
    if (playerRow === undefined) return null;

    const [state, location, battle, unlocks] = await Promise.all([
      this.client.query<{ state: string }>(
        "SELECT state FROM onboarding_states WHERE player_id = $1",
        [playerId],
      ),
      this.client.query<{ area_id: string }>(
        "SELECT area_id FROM player_locations WHERE player_id = $1",
        [playerId],
      ),
      this.client.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM battle_sides side
           JOIN battles battle ON battle.id = side.battle_id
           WHERE side.player_id = $1
             AND battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
         ) AS active`,
        [playerId],
      ),
      this.client.query<{ unlock_key: string }>(
        `SELECT unlock_key FROM trainer_unlocks
         WHERE player_id = $1 AND status = 'ACTIVE'
         ORDER BY unlock_key`,
        [playerId],
      ),
    ]);

    return {
      playerActive: playerRow.status === "ACTIVE",
      onboardingComplete: state.rows[0]?.state === "COMPLETE",
      areaId: location.rows[0]?.area_id ?? null,
      activeBattle: battle.rows[0]?.active ?? false,
      unlockKeys: unlocks.rows.map((row) => row.unlock_key),
    };
  }

  public async byCreationKey(
    playerId: PlayerId,
    creationIdempotencyKey: string,
    lock = false,
  ): Promise<EncounterRecord | null> {
    const result = await this.client.query<EncounterRow>(
      `${ENCOUNTER_SELECT}
       WHERE player_id = $1 AND creation_idempotency_key = $2
       ${lock ? "FOR UPDATE" : ""}`,
      [playerId, creationIdempotencyKey],
    );
    return result.rows[0] === undefined ? null : mapEncounter(result.rows[0]);
  }

  public async activeForPlayer(playerId: PlayerId, lock = false): Promise<EncounterRecord | null> {
    const result = await this.client.query<EncounterRow>(
      `${ENCOUNTER_SELECT}
       WHERE player_id = $1
         AND status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE')
       ORDER BY created_at DESC
       LIMIT 1
       ${lock ? "FOR UPDATE" : ""}`,
      [playerId],
    );
    return result.rows[0] === undefined ? null : mapEncounter(result.rows[0]);
  }

  public async byId(
    playerId: PlayerId,
    encounterId: EncounterId,
    lock = false,
  ): Promise<EncounterRecord | null> {
    const result = await this.client.query<EncounterRow>(
      `${ENCOUNTER_SELECT}
       WHERE player_id = $1 AND id = $2
       ${lock ? "FOR UPDATE" : ""}`,
      [playerId, encounterId],
    );
    return result.rows[0] === undefined ? null : mapEncounter(result.rows[0]);
  }

  public async snapshot(encounterId: EncounterId): Promise<WildPokemonSnapshot | null> {
    const result = await this.client.query<{ pokemon_snapshot: unknown }>(
      "SELECT pokemon_snapshot FROM encounter_snapshots WHERE encounter_id = $1",
      [encounterId],
    );
    const value = result.rows[0]?.pokemon_snapshot;
    if (value === undefined) return null;
    const parsed = WildPokemonSnapshotSchema.safeParse(value);
    if (!parsed.success) throw new Error("Database returned an invalid wild Pokemon snapshot");
    return parsed.data;
  }

  public async battleId(encounterId: EncounterId): Promise<string | null> {
    const result = await this.client.query<{ id: string }>(
      "SELECT id FROM battles WHERE encounter_id = $1",
      [encounterId],
    );
    return result.rows[0]?.id ?? null;
  }

  public async tables(
    contentReleaseId: string,
    areaId: string,
  ): Promise<readonly EncounterTableRecord[]> {
    const tables = await this.client.query<{
      revision_id: string;
      encounter_table_id: string;
      slug: string;
      active: boolean;
      conditions: unknown;
    }>(
      `SELECT revision.id AS revision_id,
              table_identity.id AS encounter_table_id,
              table_identity.slug,
              revision.active,
              revision.conditions
       FROM encounter_tables table_identity
       JOIN encounter_table_revisions revision
         ON revision.encounter_table_id = table_identity.id
        AND revision.content_release_id = $1
       WHERE table_identity.area_id = $2
       ORDER BY table_identity.slug, table_identity.id`,
      [contentReleaseId, areaId],
    );

    const output: EncounterTableRecord[] = [];
    for (const table of tables.rows) {
      const tableConditions = parseEncounterConditions(table.conditions);
      if (!tableConditions.success) {
        throw new Error(
          `Published encounter table ${table.encounter_table_id} has invalid conditions`,
        );
      }
      const entries = await this.client.query<{
        id: string;
        form_id: string;
        weight: string;
        min_level: number;
        max_level: number;
        active: boolean;
        conditions: unknown;
      }>(
        `SELECT id, form_id, weight::text, min_level, max_level, active, conditions
         FROM encounter_entries
         WHERE encounter_table_revision_id = $1
         ORDER BY id`,
        [table.revision_id],
      );
      output.push({
        encounterTableId: table.encounter_table_id,
        slug: table.slug,
        active: table.active,
        conditions: tableConditions.data,
        entries: entries.rows.map((entry) => {
          const conditions = parseEncounterConditions(entry.conditions);
          if (!conditions.success) {
            throw new Error(`Published encounter entry ${entry.id} has invalid conditions`);
          }
          const weight = Number(entry.weight);
          if (!Number.isSafeInteger(weight) || weight <= 0) {
            throw new Error(`Published encounter entry ${entry.id} has unsafe weight`);
          }
          return {
            entryId: entry.id,
            formId: entry.form_id,
            weight,
            minLevel: entry.min_level,
            maxLevel: entry.max_level,
            active: entry.active,
            conditions: conditions.data,
          };
        }),
      });
    }
    return output;
  }

  public async wildBuild(
    contentReleaseId: string,
    formId: string,
  ): Promise<WildPokemonBuild | null> {
    const form = await this.client.query<{
      form_id: string;
      species_id: string;
      type1_id: string;
      type2_id: string | null;
      base_hp: number;
      base_attack: number;
      base_defense: number;
      base_sp_attack: number;
      base_sp_defense: number;
      base_speed: number;
    }>(
      `SELECT form.id AS form_id, form.species_id,
              revision.type1_id, revision.type2_id,
              revision.base_hp, revision.base_attack, revision.base_defense,
              revision.base_sp_attack, revision.base_sp_defense, revision.base_speed
       FROM pokemon_forms form
       JOIN pokemon_form_revisions revision
         ON revision.form_id = form.id
        AND revision.content_release_id = $1
       JOIN pokemon_species_revisions species_revision
         ON species_revision.species_id = form.species_id
        AND species_revision.content_release_id = $1
       WHERE form.id = $2
         AND revision.active = TRUE
         AND species_revision.active = TRUE`,
      [contentReleaseId, formId],
    );
    const row = form.rows[0];
    if (row === undefined) return null;

    const [abilities, natures, moves] = await Promise.all([
      this.client.query<{ ability_id: string }>(
        `SELECT option.ability_id
         FROM pokemon_form_ability_options option
         JOIN ability_revisions revision
           ON revision.ability_id = option.ability_id
          AND revision.content_release_id = option.content_release_id
         WHERE option.content_release_id = $1
           AND option.form_id = $2
           AND option.active = TRUE
           AND revision.active = TRUE
         ORDER BY option.slot_kind, option.ability_id`,
        [contentReleaseId, formId],
      ),
      this.client.query<{ nature_id: string }>(
        `SELECT nature_id FROM nature_revisions
         WHERE content_release_id = $1 AND active = TRUE
         ORDER BY nature_id`,
        [contentReleaseId],
      ),
      this.client.query<{
        move_id: string;
        learn_method: string;
        learn_level: number | null;
        max_pp: number | null;
      }>(
        `SELECT learnset.move_id, learnset.learn_method, learnset.learn_level, revision.max_pp
         FROM move_learnset_entries learnset
         JOIN move_revisions revision
           ON revision.move_id = learnset.move_id
          AND revision.content_release_id = learnset.content_release_id
         WHERE learnset.content_release_id = $1
           AND learnset.form_id = $2
           AND learnset.active = TRUE
           AND revision.active = TRUE
           AND learnset.learn_method IN ('START', 'LEVEL')
         ORDER BY CASE WHEN learnset.learn_method = 'START' THEN 0 ELSE 1 END,
                  COALESCE(learnset.learn_level, 0), learnset.move_id`,
        [contentReleaseId, formId],
      ),
    ]);

    return {
      formId: row.form_id,
      speciesId: row.species_id,
      type1Id: row.type1_id,
      type2Id: row.type2_id,
      baseStats: {
        hp: row.base_hp,
        attack: row.base_attack,
        defense: row.base_defense,
        spAttack: row.base_sp_attack,
        spDefense: row.base_sp_defense,
        speed: row.base_speed,
      },
      abilityIds: abilities.rows.map((ability) => ability.ability_id),
      natureIds: natures.rows.map((nature) => nature.nature_id),
      moves: moves.rows.map((move) => {
        if (move.max_pp === null) {
          throw new Error(`Published move ${move.move_id} has no max PP for encounter generation`);
        }
        return {
          moveId: move.move_id,
          learnMethod: move.learn_method,
          learnLevel: move.learn_level,
          maxPp: move.max_pp,
        };
      }),
    };
  }

  public async insertEncounter(input: {
    readonly encounterId: EncounterId;
    readonly playerId: PlayerId;
    readonly areaId: string;
    readonly contentReleaseId: string;
    readonly rulesetId: string;
    readonly creationIdempotencyKey: string;
    readonly seed: {
      readonly ciphertext: Uint8Array;
      readonly iv: Uint8Array;
      readonly authTag: Uint8Array;
      readonly keyVersion: number;
    };
    readonly rngCounter: bigint;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly snapshot: WildPokemonSnapshot;
  }): Promise<EncounterRecord> {
    const inserted = await this.client.query<EncounterRow>(
      `INSERT INTO encounters(
         id, player_id, area_id, status, content_release_id, ruleset_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
         rng_counter, revision, creation_idempotency_key,
         created_at, updated_at, expires_at
       ) VALUES (
         $1, $2, $3, 'CREATED', $4, $5,
         $6, $7, $8, $9,
         $10::bigint, 0, $11,
         $12, $12, $13
       )
       RETURNING id, player_id, area_id, status, content_release_id, ruleset_id,
                 creation_idempotency_key, rng_counter::text, revision::text,
                 created_at, updated_at, expires_at, closed_at`,
      [
        input.encounterId,
        input.playerId,
        input.areaId,
        input.contentReleaseId,
        input.rulesetId,
        Buffer.from(input.seed.ciphertext),
        Buffer.from(input.seed.iv),
        Buffer.from(input.seed.authTag),
        input.seed.keyVersion,
        input.rngCounter.toString(),
        input.creationIdempotencyKey,
        input.createdAt,
        input.expiresAt,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("Encounter insert did not return a row");
    await this.client.query(
      `INSERT INTO encounter_snapshots(encounter_id, schema_version, pokemon_snapshot, created_at)
       VALUES ($1, 1, $2::jsonb, $3)`,
      [input.encounterId, JSON.stringify(input.snapshot), input.createdAt],
    );
    return mapEncounter(row);
  }

  public async transition(input: {
    readonly playerId: PlayerId;
    readonly encounterId: EncounterId;
    readonly fromStatus: EncounterRecord["status"];
    readonly toStatus: EncounterRecord["status"];
    readonly expectedRevision: bigint;
    readonly closedAt: Date | null;
  }): Promise<EncounterRecord | null> {
    const result = await this.client.query<EncounterRow>(
      `UPDATE encounters
       SET status = $4,
           revision = revision + 1,
           updated_at = COALESCE($6::timestamptz, now()),
           closed_at = $6
       WHERE player_id = $1
         AND id = $2
         AND revision = $3::bigint
         AND status = $5
       RETURNING id, player_id, area_id, status, content_release_id, ruleset_id,
                 creation_idempotency_key, rng_counter::text, revision::text,
                 created_at, updated_at, expires_at, closed_at`,
      [
        input.playerId,
        input.encounterId,
        input.expectedRevision.toString(),
        input.toStatus,
        input.fromStatus,
        input.closedAt,
      ],
    );
    const row = result.rows[0];
    if (row !== undefined && input.toStatus === "PRESENTED") {
      const snapshot = await this.snapshot(input.encounterId);
      if (snapshot === null) throw new Error("Presented encounter is missing its wild snapshot");
      await recordPokedexSeen(this.client, input.playerId, snapshot.speciesId);
    }
    return row === undefined ? null : mapEncounter(row);
  }

  public async createBattle(input: {
    readonly battleId: string;
    readonly encounter: EncounterRecord;
    readonly seed: {
      readonly ciphertext: Uint8Array;
      readonly iv: Uint8Array;
      readonly authTag: Uint8Array;
      readonly keyVersion: number;
    };
  }): Promise<string> {
    await this.client.query(
      `INSERT INTO battles(
         id, battle_type, status, content_release_id, ruleset_id, encounter_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version, rng_counter
       ) VALUES ($1, 'WILD', 'CREATED', $2, $3, $4, $5, $6, $7, $8, 0)
       ON CONFLICT (encounter_id) DO NOTHING`,
      [
        input.battleId,
        input.encounter.contentReleaseId,
        input.encounter.rulesetId,
        input.encounter.encounterId,
        Buffer.from(input.seed.ciphertext),
        Buffer.from(input.seed.iv),
        Buffer.from(input.seed.authTag),
        input.seed.keyVersion,
      ],
    );
    const result = await this.client.query<{ id: string }>(
      "SELECT id FROM battles WHERE encounter_id = $1",
      [input.encounter.encounterId],
    );
    const battleId = result.rows[0]?.id;
    if (battleId === undefined) throw new Error("Encounter battle link was not persisted");
    return battleId;
  }

  public async expireDue(now: Date, limit: number): Promise<readonly EncounterId[]> {
    const result = await this.client.query<{ id: string }>(
      `WITH due AS (
         SELECT id
         FROM encounters
         WHERE expires_at IS NOT NULL
           AND expires_at <= $1
           AND status IN ('CREATED', 'PRESENTED', 'ENGAGED')
         ORDER BY expires_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE encounters encounter
       SET status = 'EXPIRED',
           closed_at = $1,
           updated_at = $1,
           revision = encounter.revision + 1
       FROM due
       WHERE encounter.id = due.id
       RETURNING encounter.id`,
      [now, limit],
    );
    return result.rows.map((row) => toEncounterId(row.id));
  }
}

export class PostgresEncounterRepository implements EncounterRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (transaction: EncounterTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresEncounterTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (transaction: EncounterTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresEncounterTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
