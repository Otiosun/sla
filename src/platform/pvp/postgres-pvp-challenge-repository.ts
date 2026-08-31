import type { Pool, PoolClient } from "pg";
import type { PvpChallenge, PvpChallengeStatus } from "../../modules/pvp/challenge.js";
import type {
  ActivePvpContent,
  InsertAcceptedPvpEncounterInput,
  PvpChallengeRepository,
  PvpChallengeTransaction,
  PvpPlayerContext,
  ReplacePvpChallengeInput,
} from "../../modules/pvp/ports.js";
import { withTransaction } from "../db/transaction.js";

interface PvpChallengeRow {
  readonly id: string;
  readonly challenger_player_id: string;
  readonly target_player_id: string;
  readonly status: string;
  readonly format_key: string;
  readonly reach_policy: string;
  readonly area_id: string;
  readonly content_release_id: string;
  readonly ruleset_id: string;
  readonly creation_idempotency_key: string;
  readonly request_fingerprint: string;
  readonly encounter_id: string | null;
  readonly battle_id: string | null;
  readonly revision: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly expires_at: Date;
  readonly accepted_at: Date | null;
  readonly started_at: Date | null;
  readonly closed_at: Date | null;
}

interface PvpPlayerContextRow {
  readonly player_id: string;
  readonly player_active: boolean;
  readonly onboarding_complete: boolean;
  readonly active_external_identity: boolean;
  readonly area_id: string | null;
  readonly has_eligible_team_pokemon: boolean;
  readonly active_encounter: boolean;
  readonly active_battle: boolean;
}

const CHALLENGE_SELECT = `
  SELECT id, challenger_player_id, target_player_id, status, format_key, reach_policy,
         area_id, content_release_id, ruleset_id, creation_idempotency_key,
         request_fingerprint, encounter_id, battle_id, revision::text,
         created_at, updated_at, expires_at, accepted_at, started_at, closed_at
  FROM pvp_challenges
`;

function safeRevision(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("PVP challenge revision is outside JS safe range");
  }
  return parsed;
}

function parseStatus(value: string): PvpChallengeStatus {
  if (
    value === "OPEN" ||
    value === "ACCEPTED" ||
    value === "DECLINED" ||
    value === "CANCELLED" ||
    value === "EXPIRED" ||
    value === "STARTED"
  ) {
    return value;
  }
  throw new Error("Database returned an invalid PVP challenge status");
}

function mapChallenge(row: PvpChallengeRow): PvpChallenge {
  if (row.format_key !== "1V1" || row.reach_policy !== "SAME_AREA") {
    throw new Error("Database returned an unsupported PVP challenge format or reach policy");
  }
  return {
    id: row.id,
    challengerPlayerId: row.challenger_player_id,
    targetPlayerId: row.target_player_id,
    status: parseStatus(row.status),
    formatKey: row.format_key,
    reachPolicy: row.reach_policy,
    areaId: row.area_id,
    contentReleaseId: row.content_release_id,
    rulesetId: row.ruleset_id,
    creationIdempotencyKey: row.creation_idempotency_key,
    requestFingerprint: row.request_fingerprint,
    encounterId: row.encounter_id,
    battleId: row.battle_id,
    revision: safeRevision(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

function mapPlayerContext(row: PvpPlayerContextRow): PvpPlayerContext {
  return {
    playerId: row.player_id,
    playerActive: row.player_active,
    onboardingComplete: row.onboarding_complete,
    activeExternalIdentity: row.active_external_identity,
    areaId: row.area_id,
    hasEligibleTeamPokemon: row.has_eligible_team_pokemon,
    activeEncounter: row.active_encounter,
    activeBattle: row.active_battle,
  };
}

class PostgresPvpChallengeTransaction implements PvpChallengeTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async playerContexts(
    playerIds: readonly string[],
    lock = false,
    contentReleaseId?: string,
  ): Promise<readonly PvpPlayerContext[]> {
    if (contentReleaseId === undefined) {
      throw new Error("PVP player eligibility requires a pinned content release");
    }
    const orderedIds = [...new Set(playerIds)].sort();
    if (orderedIds.length === 0) return [];

    if (lock) {
      await this.client.query(
        `SELECT id
         FROM players
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [orderedIds],
      );
    }

    const result = await this.client.query<PvpPlayerContextRow>(
      `SELECT p.id AS player_id,
              (p.status = 'ACTIVE') AS player_active,
              COALESCE(os.state = 'COMPLETE', FALSE) AS onboarding_complete,
              EXISTS (
                SELECT 1
                FROM player_identities identity
                WHERE identity.player_id = p.id AND identity.status = 'ACTIVE'
              ) AS active_external_identity,
              location.area_id,
              EXISTS (
                SELECT 1
                FROM pokemon_roster_slots roster
                JOIN pokemon_instances pokemon
                  ON pokemon.id = roster.pokemon_instance_id
                 AND pokemon.owner_player_id = roster.player_id
                JOIN pokemon_form_revisions form_revision
                  ON form_revision.form_id = pokemon.form_id
                 AND form_revision.content_release_id = $2::uuid
                LEFT JOIN pokemon_training_values training
                  ON training.pokemon_instance_id = pokemon.id
                WHERE roster.player_id = p.id
                  AND roster.placement_kind = 'TEAM'
                  AND pokemon.status = 'ACTIVE'
                  AND training.nature_id IS NOT NULL
                  AND pokemon.ability_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM nature_revisions nature
                    WHERE nature.nature_id = training.nature_id
                      AND nature.content_release_id = $2::uuid
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM ability_revisions ability
                    WHERE ability.ability_id = pokemon.ability_id
                      AND ability.content_release_id = $2::uuid
                  )
                  AND (
                    SELECT count(*)
                    FROM pokemon_move_slots slot
                    WHERE slot.pokemon_instance_id = pokemon.id
                  ) BETWEEN 1 AND 4
                  AND NOT EXISTS (
                    SELECT 1
                    FROM pokemon_move_slots slot
                    LEFT JOIN move_revisions move
                      ON move.move_id = slot.move_id
                     AND move.content_release_id = $2::uuid
                    WHERE slot.pokemon_instance_id = pokemon.id
                      AND move.move_id IS NULL
                  )
              ) AS has_eligible_team_pokemon,
              EXISTS (
                SELECT 1
                FROM encounter_players participant
                WHERE participant.player_id = p.id AND participant.active = TRUE
              ) AS active_encounter,
              EXISTS (
                SELECT 1
                FROM battle_sides side
                JOIN battles battle ON battle.id = side.battle_id
                WHERE side.player_id = p.id
                  AND battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
              ) AS active_battle
       FROM players p
       LEFT JOIN onboarding_states os ON os.player_id = p.id
       LEFT JOIN player_locations location ON location.player_id = p.id
       WHERE p.id = ANY($1::uuid[])
       ORDER BY p.id`,
      [orderedIds, contentReleaseId],
    );
    return result.rows.map(mapPlayerContext);
  }

  public async activeContent(): Promise<ActivePvpContent | null> {
    const result = await this.client.query<{
      content_release_id: string;
      ruleset_id: string;
    }>(
      `SELECT release.id AS content_release_id, ruleset.id AS ruleset_id
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
        };
  }

  public async pinnedContentAvailable(contentReleaseId: string, rulesetId: string): Promise<boolean> {
    const result = await this.client.query<{ available: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM content_releases release
         JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
         WHERE release.id = $1
           AND ruleset.id = $2
           AND release.status IN ('PUBLISHED', 'ARCHIVED')
           AND ruleset.status IN ('PUBLISHED', 'ARCHIVED')
       ) AS available`,
      [contentReleaseId, rulesetId],
    );
    return result.rows[0]?.available ?? false;
  }

  public async challengeById(challengeId: string, lock = false): Promise<PvpChallenge | null> {
    const result = await this.client.query<PvpChallengeRow>(
      `${CHALLENGE_SELECT}
       WHERE id = $1
       ${lock ? "FOR UPDATE" : ""}`,
      [challengeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapChallenge(row);
  }

  public async challengeByCreationKey(
    challengerPlayerId: string,
    creationIdempotencyKey: string,
    lock = false,
  ): Promise<PvpChallenge | null> {
    const result = await this.client.query<PvpChallengeRow>(
      `${CHALLENGE_SELECT}
       WHERE challenger_player_id = $1 AND creation_idempotency_key = $2
       ${lock ? "FOR UPDATE" : ""}`,
      [challengerPlayerId, creationIdempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapChallenge(row);
  }

  public async insertChallenge(challenge: PvpChallenge): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO pvp_challenges(
         id, challenger_player_id, target_player_id, status, format_key, reach_policy,
         area_id, content_release_id, ruleset_id, creation_idempotency_key,
         request_fingerprint, encounter_id, battle_id, revision,
         created_at, updated_at, expires_at, accepted_at, started_at, closed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20
       )
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        challenge.id,
        challenge.challengerPlayerId,
        challenge.targetPlayerId,
        challenge.status,
        challenge.formatKey,
        challenge.reachPolicy,
        challenge.areaId,
        challenge.contentReleaseId,
        challenge.rulesetId,
        challenge.creationIdempotencyKey,
        challenge.requestFingerprint,
        challenge.encounterId,
        challenge.battleId,
        challenge.revision,
        challenge.createdAt,
        challenge.updatedAt,
        challenge.expiresAt,
        challenge.acceptedAt,
        challenge.startedAt,
        challenge.closedAt,
      ],
    );
    return result.rowCount === 1;
  }

  public async replaceChallenge(input: ReplacePvpChallengeInput): Promise<boolean> {
    if (input.next.revision !== input.expectedRevision + 1) {
      throw new Error("PVP challenge replacement must advance revision exactly once");
    }
    const result = await this.client.query(
      `UPDATE pvp_challenges
       SET status = $3,
           encounter_id = $4,
           battle_id = $5,
           revision = $6,
           updated_at = $7,
           accepted_at = $8,
           started_at = $9,
           closed_at = $10
       WHERE id = $1 AND revision = $2
       RETURNING id`,
      [
        input.next.id,
        input.expectedRevision,
        input.next.status,
        input.next.encounterId,
        input.next.battleId,
        input.next.revision,
        input.next.updatedAt,
        input.next.acceptedAt,
        input.next.startedAt,
        input.next.closedAt,
      ],
    );
    return result.rowCount === 1;
  }

  public async insertAcceptedEncounter(input: InsertAcceptedPvpEncounterInput): Promise<void> {
    const { challenge, seed } = input;
    if (
      challenge.status !== "ACCEPTED" ||
      challenge.encounterId === null ||
      challenge.acceptedAt === null
    ) {
      throw new Error("Accepted PVP Encounter requires an ACCEPTED challenge with Encounter id");
    }

    await this.client.query(
      `INSERT INTO encounters(
         id, player_id, area_id, status, content_release_id, ruleset_id, mode,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
         rng_counter, revision, creation_idempotency_key, created_at, updated_at, expires_at
       ) VALUES (
         $1, $2, $3, 'PRESENTED', $4, $5, 'PVP',
         $6, $7, $8, $9,
         0, 0, $10, $11, $11, NULL
       )`,
      [
        challenge.encounterId,
        challenge.challengerPlayerId,
        challenge.areaId,
        challenge.contentReleaseId,
        challenge.rulesetId,
        Buffer.from(seed.ciphertext),
        Buffer.from(seed.iv),
        Buffer.from(seed.authTag),
        seed.keyVersion,
        `pvp-challenge:${challenge.id}`,
        challenge.acceptedAt,
      ],
    );

    await this.client.query(
      `INSERT INTO encounter_players(encounter_id, player_id, side_no, role, active, created_at, updated_at)
       VALUES
         ($1, $2, 1, 'CHALLENGER', TRUE, $4, $4),
         ($1, $3, 2, 'TARGET', TRUE, $4, $4)`,
      [
        challenge.encounterId,
        challenge.challengerPlayerId,
        challenge.targetPlayerId,
        challenge.acceptedAt,
      ],
    );
  }
}

export class PostgresPvpChallengeRepository implements PvpChallengeRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    work: (transaction: PvpChallengeTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, (client) =>
      work(new PostgresPvpChallengeTransaction(client)),
    );
  }

  public async read<T>(work: (transaction: PvpChallengeTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      (client) => work(new PostgresPvpChallengeTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
