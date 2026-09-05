import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { BattleState } from "../../modules/battle/contracts.js";
import { initializeBattleState } from "../../modules/battle/initialization.js";
import type { BattleRootRecord } from "../../modules/battle/ports.js";
import type { EncounterSeedProvider } from "../../modules/encounter/ports.js";
import type {
  PvpStartRepository,
  PvpStartRepositoryInput,
  PvpStartRepositoryOutput,
} from "../../modules/pvp/ports.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { openTurnWindowInTransaction } from "../battle/postgres-battle-turn-window-repository.js";
import { loadPlayerBattleParty } from "../battle/postgres-player-party-reader.js";
import { withTransaction } from "../db/transaction.js";

const uuid = z.string().uuid();

interface ChallengeRow {
  readonly id: string;
  readonly challenger_player_id: string;
  readonly target_player_id: string;
  readonly status: string;
  readonly area_id: string;
  readonly content_release_id: string;
  readonly ruleset_id: string;
  readonly encounter_id: string | null;
  readonly battle_id: string | null;
  readonly revision: string;
}

interface EncounterRow {
  readonly id: string;
  readonly status: string;
  readonly mode: string;
  readonly area_id: string;
  readonly content_release_id: string;
  readonly ruleset_id: string;
  readonly revision: string;
}

interface PlayerEligibilityRow {
  readonly id: string;
  readonly player_active: boolean;
  readonly onboarding_complete: boolean;
  readonly active_external_identity: boolean;
  readonly area_id: string | null;
  readonly incompatible_encounter: boolean;
  readonly active_battle: boolean;
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function safeRevision(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside JS safe range`);
  }
  return parsed;
}

async function loadChallenge(
  client: PoolClient,
  challengeId: string,
): Promise<ChallengeRow | null> {
  const result = await client.query<ChallengeRow>(
    `SELECT id, challenger_player_id, target_player_id, status, area_id,
            content_release_id, ruleset_id, encounter_id, battle_id, revision::text
     FROM pvp_challenges
     WHERE id = $1
     FOR UPDATE`,
    [challengeId],
  );
  return result.rows[0] ?? null;
}

async function loadStartedReplay(
  client: PoolClient,
  challenge: ChallengeRow,
): Promise<Result<PvpStartRepositoryOutput>> {
  if (challenge.encounter_id === null || challenge.battle_id === null) {
    throw new Error("STARTED PVP challenge is missing durable Encounter/Battle linkage");
  }
  const window = await client.query<{ id: string }>(
    `SELECT id
     FROM battle_turn_windows
     WHERE battle_id = $1 AND battle_version = 0`,
    [challenge.battle_id],
  );
  const turnWindowId = window.rows[0]?.id;
  if (turnWindowId === undefined) {
    throw new Error("STARTED PVP challenge is missing its initial TurnWindow");
  }
  return ok({
    challengeId: challenge.id,
    encounterId: challenge.encounter_id,
    battleId: challenge.battle_id,
    turnWindowId,
    replayed: true,
  });
}

async function lockPlayers(client: PoolClient, playerIds: readonly string[]): Promise<void> {
  const ordered = [...new Set(playerIds)].sort();
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM players
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [ordered],
  );
  if (result.rows.length !== ordered.length) {
    throw new Error("PVP START participant disappeared while acquiring player locks");
  }
}

async function loadEncounter(
  client: PoolClient,
  encounterId: string,
): Promise<EncounterRow | null> {
  const result = await client.query<EncounterRow>(
    `SELECT id, status, mode, area_id, content_release_id, ruleset_id, revision::text
     FROM encounters
     WHERE id = $1
     FOR UPDATE`,
    [encounterId],
  );
  return result.rows[0] ?? null;
}

async function pinnedContentAvailable(
  client: PoolClient,
  contentReleaseId: string,
  rulesetId: string,
): Promise<boolean> {
  const result = await client.query<{ available: boolean }>(
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

async function playerEligibility(
  client: PoolClient,
  playerIds: readonly string[],
  encounterId: string,
): Promise<readonly PlayerEligibilityRow[]> {
  const result = await client.query<PlayerEligibilityRow>(
    `SELECT p.id,
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
              FROM encounter_players participant
              WHERE participant.player_id = p.id
                AND participant.active = TRUE
                AND participant.encounter_id <> $2
            ) AS incompatible_encounter,
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
    [[...playerIds], encounterId],
  );
  return result.rows;
}

function eligibilityError(
  context: PlayerEligibilityRow,
  expectedAreaId: string,
): ReturnType<typeof appError> | null {
  if (!context.player_active) {
    return appError("PLAYER_INELIGIBLE", "Player is not eligible for PVP", {
      reason: "player-not-active",
      playerId: context.id,
    });
  }
  if (!context.onboarding_complete) {
    return appError("PLAYER_INELIGIBLE", "Player is not eligible for PVP", {
      reason: "onboarding-incomplete",
      playerId: context.id,
    });
  }
  if (!context.active_external_identity) {
    return appError("PLAYER_INELIGIBLE", "Player is not eligible for PVP", {
      reason: "external-identity-missing",
      playerId: context.id,
    });
  }
  if (context.area_id !== expectedAreaId) {
    return appError("ACTION_INVALID", "PVP action is invalid", {
      reason: "pvp-same-area-required",
    });
  }
  if (context.incompatible_encounter || context.active_battle) {
    return appError("FLOW_BLOCKED", "PVP flow is blocked", {
      reason: "active-mechanical-flow",
    });
  }
  return null;
}

async function persistBattleState(
  client: PoolClient,
  root: BattleRootRecord,
  state: BattleState,
): Promise<void> {
  const sideIdByNo = new Map<number, string>();
  for (const side of state.sides) {
    const sideId = randomUUID();
    sideIdByNo.set(side.sideNo, sideId);
    await client.query(
      `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id, result)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sideId, root.battleId, side.sideNo, side.controllerKind, side.playerId, side.result],
    );
  }

  for (const combatant of state.combatants) {
    const sideId = sideIdByNo.get(combatant.sideNo);
    if (sideId === undefined) throw new Error("PVP Battle side mapping is incomplete");
    await client.query(
      `INSERT INTO battle_participants(
         id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
         roster_position, active_member, snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7::jsonb)`,
      [
        combatant.participantId,
        root.battleId,
        sideId,
        combatant.pokemonInstanceId,
        combatant.participantKind,
        combatant.rosterPosition,
        JSON.stringify(combatant),
      ],
    );
  }

  await client.query(
    `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
     VALUES ($1, 0, 1, $2::jsonb)`,
    [root.battleId, JSON.stringify(state)],
  );
  const activated = await client.query(
    `UPDATE battles
     SET status = 'ACTIVE', updated_at = now()
     WHERE id = $1 AND status = 'CREATED' AND version = 0`,
    [root.battleId],
  );
  if (activated.rowCount !== 1) throw new Error("PVP Battle activation CAS failed");
}

export class PostgresPvpStartRepository implements PvpStartRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly seedProvider: EncounterSeedProvider,
  ) {}

  public async start(input: PvpStartRepositoryInput): Promise<Result<PvpStartRepositoryOutput>> {
    if (
      !uuid.safeParse(input.challengeId).success ||
      !uuid.safeParse(input.actorPlayerId).success
    ) {
      return err(appError("INVALID_ID", "PVP challenge and actor ids must be valid UUIDs"));
    }
    if (!isValidDate(input.startedAt) || !isValidDate(input.deadlineAt)) {
      return err(appError("VALIDATION_FAILED", "PVP START timestamps must be valid dates"));
    }
    if (input.deadlineAt.getTime() <= input.startedAt.getTime()) {
      return err(appError("VALIDATION_FAILED", "PVP TurnWindow deadline must be after START"));
    }

    return withTransaction(this.pool, async (client) => {
      const challenge = await loadChallenge(client, input.challengeId);
      if (challenge === null) {
        return err(
          appError("NOT_FOUND", "PVP challenge was not found", {
            challengeId: input.challengeId,
          }),
        );
      }
      const participants = [challenge.challenger_player_id, challenge.target_player_id] as const;
      if (!participants.includes(input.actorPlayerId)) {
        return err(
          appError("ACTION_INVALID", "PVP action is invalid", {
            reason: "challenge-actor-forbidden",
          }),
        );
      }
      if (challenge.status === "STARTED") {
        return loadStartedReplay(client, challenge);
      }
      if (challenge.status !== "ACCEPTED" || challenge.encounter_id === null) {
        return err(
          appError("FLOW_BLOCKED", "PVP flow is blocked", {
            reason: "challenge-not-accepted",
          }),
        );
      }

      await lockPlayers(client, participants);
      const encounter = await loadEncounter(client, challenge.encounter_id);
      if (encounter === null) {
        throw new Error("Accepted PVP challenge is missing its Encounter");
      }
      if (
        encounter.mode !== "PVP" ||
        encounter.status !== "PRESENTED" ||
        encounter.area_id !== challenge.area_id ||
        encounter.content_release_id !== challenge.content_release_id ||
        encounter.ruleset_id !== challenge.ruleset_id
      ) {
        return err(
          appError("FLOW_BLOCKED", "PVP flow is blocked", {
            reason: "encounter-not-startable",
          }),
        );
      }
      if (
        !(await pinnedContentAvailable(client, challenge.content_release_id, challenge.ruleset_id))
      ) {
        return err(
          appError("FLOW_BLOCKED", "PVP flow is blocked", {
            reason: "pinned-content-unavailable",
          }),
        );
      }

      const contexts = await playerEligibility(client, participants, encounter.id);
      if (contexts.length !== 2) {
        return err(
          appError("PLAYER_INELIGIBLE", "Player is not eligible for PVP", {
            reason: "player-not-found",
          }),
        );
      }
      for (const context of contexts) {
        const invalid = eligibilityError(context, challenge.area_id);
        if (invalid !== null) return err(invalid);
      }

      const challengerParty = (
        await loadPlayerBattleParty(
          client,
          challenge.content_release_id,
          challenge.challenger_player_id,
        )
      ).filter((pokemon) => pokemon.rosterPosition <= 6 && pokemon.currentHp > 0);
      const targetParty = (
        await loadPlayerBattleParty(
          client,
          challenge.content_release_id,
          challenge.target_player_id,
        )
      ).filter((pokemon) => pokemon.rosterPosition <= 6 && pokemon.currentHp > 0);
      if (challengerParty.length === 0 || targetParty.length === 0) {
        return err(
          appError("PLAYER_INELIGIBLE", "Player is not eligible for PVP", {
            reason: "battle-ready-team-missing",
          }),
        );
      }

      const seed = this.seedProvider.create(`pvp:challenge:${challenge.id}:battle`);
      const battleId = randomUUID();
      const root: BattleRootRecord = {
        battleId,
        battleType: "PVP",
        status: "CREATED",
        contentReleaseId: challenge.content_release_id,
        rulesetId: challenge.ruleset_id,
        encounterId: encounter.id,
        turnNumber: 0,
        version: 0,
        seed: seed.envelope,
        rngCounter: 0n,
        endedAt: null,
      };
      const initialized = initializeBattleState({
        root,
        sides: [
          {
            sideNo: 1,
            controllerKind: "PLAYER",
            playerId: challenge.challenger_player_id,
            party: challengerParty,
          },
          {
            sideNo: 2,
            controllerKind: "PLAYER",
            playerId: challenge.target_player_id,
            party: targetParty,
          },
        ],
        idFactory: randomUUID,
      });
      if (!initialized.ok) {
        return err(
          appError("VALIDATION_FAILED", initialized.error.message, initialized.error.details),
        );
      }

      const encounterRevision = safeRevision(encounter.revision, "PVP Encounter revision");
      const engaged = await client.query(
        `UPDATE encounters
         SET status = 'ENGAGED', revision = revision + 1, updated_at = $4
         WHERE id = $1 AND status = 'PRESENTED' AND revision = $2
           AND mode = 'PVP' AND content_release_id = $3
         RETURNING id`,
        [encounter.id, encounterRevision, challenge.content_release_id, input.startedAt],
      );
      if (engaged.rowCount !== 1) {
        return err(appError("REVISION_CONFLICT", "PVP Encounter START lost a revision race"));
      }

      await client.query(
        `INSERT INTO battles(
           id, battle_type, status, content_release_id, ruleset_id, encounter_id,
           turn_number, version, rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag,
           rng_seed_key_version, rng_counter, created_at, updated_at
         ) VALUES (
           $1, 'PVP', 'CREATED', $2, $3, $4,
           0, 0, $5, $6, $7,
           $8, 0, $9, $9
         )`,
        [
          battleId,
          challenge.content_release_id,
          challenge.ruleset_id,
          encounter.id,
          Buffer.from(seed.envelope.ciphertext),
          Buffer.from(seed.envelope.iv),
          Buffer.from(seed.envelope.authTag),
          seed.envelope.keyVersion,
          input.startedAt,
        ],
      );

      await persistBattleState(client, root, initialized.value);

      const turnWindow = await openTurnWindowInTransaction(client, {
        id: randomUUID(),
        battleId,
        battleVersion: 0,
        turnNumber: 0,
        openedAt: input.startedAt,
        deadlineAt: input.deadlineAt,
        requiredPlayers: [
          { playerId: challenge.challenger_player_id, sideNo: 1 },
          { playerId: challenge.target_player_id, sideNo: 2 },
        ],
      });
      if (!turnWindow.ok) {
        throw new Error(`Initial PVP TurnWindow failed: ${turnWindow.error.message}`);
      }

      const inBattle = await client.query(
        `UPDATE encounters
         SET status = 'IN_BATTLE', revision = revision + 1, updated_at = $3
         WHERE id = $1 AND status = 'ENGAGED' AND revision = $2
         RETURNING id`,
        [encounter.id, encounterRevision + 1, input.startedAt],
      );
      if (inBattle.rowCount !== 1) {
        throw new Error("PVP Encounter IN_BATTLE transition CAS failed");
      }

      const challengeRevision = safeRevision(challenge.revision, "PVP challenge revision");
      const started = await client.query(
        `UPDATE pvp_challenges
         SET status = 'STARTED', battle_id = $3, revision = revision + 1,
             started_at = $4, updated_at = $4
         WHERE id = $1 AND status = 'ACCEPTED' AND revision = $2
         RETURNING id`,
        [challenge.id, challengeRevision, battleId, input.startedAt],
      );
      if (started.rowCount !== 1) {
        throw new Error("PVP challenge START transition CAS failed");
      }

      return ok({
        challengeId: challenge.id,
        encounterId: encounter.id,
        battleId,
        turnWindowId: turnWindow.value.aggregate.window.id,
        replayed: false,
      });
    });
  }
}
