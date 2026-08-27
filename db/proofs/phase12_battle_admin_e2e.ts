import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CBattleAdminOperations } from "../../src/modules/admin/battle-definitions.js";
import { AdminBattleOperationService } from "../../src/modules/admin/battle-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import type { BattleState } from "../../src/modules/battle/contracts.js";
import { BattleAdminOwnerService } from "../../src/modules/battle/admin-service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresBattleAdminRepository } from "../../src/platform/battle/postgres-battle-admin-repository.js";
import { PostgresBattleCancellation } from "../../src/platform/battle/postgres-battle-cancellation.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

function expectAdminCode(error: unknown, code: string): void {
  if (!(error instanceof AdminError) || error.code !== code) {
    throw error instanceof Error ? error : new Error(`Expected ${code}`);
  }
}

async function expectRejected(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Expected rejection ${code}`);
    },
    (error: unknown) => expectAdminCode(error, code),
  );
}

function expectOwnerError<T extends { readonly ok: boolean }>(
  result: T,
  code: string,
  label: string,
): void {
  if (result.ok) throw new Error(`${label} unexpectedly succeeded`);
  const error = (result as { readonly error?: { readonly code?: string } }).error;
  if (error?.code !== code) {
    throw new Error(`${label} returned ${String(error?.code)} instead of ${code}`);
  }
}

interface BattleFixture {
  readonly playerId: string;
  readonly battleId: string;
  readonly encounterId: string | null;
  readonly participantId: string;
  readonly moveSlot: number;
  readonly initialHp: number;
  readonly initialPp: number;
}

function combatant(input: {
  participantId: string;
  sideNo: number;
  participantKind: "PLAYER_POKEMON" | "WILD_POKEMON";
  pokemonInstanceId: string | null;
}): BattleState["combatants"][number] {
  const moveId = randomUUID();
  const typeId = randomUUID();
  return {
    participantId: input.participantId,
    sideNo: input.sideNo,
    rosterPosition: 1,
    participantKind: input.participantKind,
    pokemonInstanceId: input.pokemonInstanceId,
    formId: randomUUID(),
    speciesId: randomUUID(),
    level: 10,
    type1Id: typeId,
    type1Slug: "normal",
    type2Id: null,
    type2Slug: null,
    baseStats: { hp: 50, attack: 50, defense: 50, spAttack: 50, spDefense: 50, speed: 50 },
    ivs: { hp: 15, attack: 15, defense: 15, spAttack: 15, spDefense: 15, speed: 15 },
    nature: { natureId: randomUUID(), increasedStat: null, decreasedStat: null },
    ability: { abilityId: randomUUID(), effectKey: null, effectConfig: {} },
    moves: [
      {
        slotNo: 1,
        moveId,
        typeId,
        typeSlug: "normal",
        category: "PHYSICAL",
        power: 40,
        accuracy: 100,
        priority: 0,
        maxPp: 35,
        ppCurrent: 35,
        effectKey: null,
        effectConfig: {},
        flags: { makesContact: true },
      },
    ],
    maxHp: 40,
    currentHp: 40,
    majorStatus: null,
    stages: {
      attack: 0,
      defense: 0,
      spAttack: 0,
      spDefense: 0,
      speed: 0,
      accuracy: 0,
      evasion: 0,
    },
    volatile: { flinch: false, confusionTurns: 0 },
  };
}

function wildBattleState(input: {
  battleId: string;
  encounterId: string;
  playerId: string;
  releaseId: string;
  rulesetId: string;
  participantId: string;
}): BattleState {
  const player = combatant({
    participantId: input.participantId,
    sideNo: 1,
    participantKind: "PLAYER_POKEMON",
    pokemonInstanceId: randomUUID(),
  });
  const wild = combatant({
    participantId: randomUUID(),
    sideNo: 2,
    participantKind: "WILD_POKEMON",
    pokemonInstanceId: null,
  });
  return {
    schemaVersion: 1,
    battleId: input.battleId,
    battleType: "WILD",
    status: "ACTIVE",
    contentReleaseId: input.releaseId,
    rulesetId: input.rulesetId,
    encounterId: input.encounterId,
    turnNumber: 0,
    version: 0,
    rngCounter: "0",
    sides: [
      {
        sideNo: 1,
        controllerKind: "PLAYER",
        playerId: input.playerId,
        participantIds: [player.participantId],
        activeParticipantId: player.participantId,
        result: null,
      },
      {
        sideNo: 2,
        controllerKind: "WILD",
        playerId: null,
        participantIds: [wild.participantId],
        activeParticipantId: wild.participantId,
        result: null,
      },
    ],
    combatants: [player, wild],
  };
}

function pvpBattleState(input: {
  battleId: string;
  playerA: string;
  playerB: string;
  releaseId: string;
  rulesetId: string;
  participantA: string;
}): BattleState {
  const first = combatant({
    participantId: input.participantA,
    sideNo: 1,
    participantKind: "PLAYER_POKEMON",
    pokemonInstanceId: randomUUID(),
  });
  const second = combatant({
    participantId: randomUUID(),
    sideNo: 2,
    participantKind: "PLAYER_POKEMON",
    pokemonInstanceId: randomUUID(),
  });
  return {
    schemaVersion: 1,
    battleId: input.battleId,
    battleType: "PVP",
    status: "ACTIVE",
    contentReleaseId: input.releaseId,
    rulesetId: input.rulesetId,
    encounterId: null,
    turnNumber: 0,
    version: 0,
    rngCounter: "0",
    sides: [
      {
        sideNo: 1,
        controllerKind: "PLAYER",
        playerId: input.playerA,
        participantIds: [first.participantId],
        activeParticipantId: first.participantId,
        result: null,
      },
      {
        sideNo: 2,
        controllerKind: "PLAYER",
        playerId: input.playerB,
        participantIds: [second.participantId],
        activeParticipantId: second.participantId,
        result: null,
      },
    ],
    combatants: [first, second],
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const globalPrincipalId = randomUUID();
  const supportPrincipalId = randomUUID();

  const correctionPlayerId = randomUUID();
  const cancelPlayerId = randomUUID();
  const deniedPlayerId = randomUUID();
  const pvpPlayerA = randomUUID();
  const pvpPlayerB = randomUUID();

  const correctionEncounterId = randomUUID();
  const cancelEncounterId = randomUUID();
  const deniedEncounterId = randomUUID();

  const nextRelease = await pool.query<{ release_no: string }>(
    `SELECT (COALESCE(MAX(release_no), 960000) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = nextRelease.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate Battle admin proof release");

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `phase12-battle-admin-${rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 12 Battle Admin Proof', 'DRAFT', $3)`,
    [releaseId, releaseNo, rulesetId],
  );
  await pool.query(`INSERT INTO regions(id, slug) VALUES ($1, $2)`, [
    regionId,
    `phase12-battle-admin-region-${regionId}`,
  ]);
  await pool.query(`INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)`, [
    areaId,
    regionId,
    `phase12-battle-admin-area-${areaId}`,
  ]);

  for (const playerId of [
    correctionPlayerId,
    cancelPlayerId,
    deniedPlayerId,
    pvpPlayerA,
    pvpPlayerB,
  ]) {
    await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [playerId]);
  }

  const seedCiphertext = Buffer.alloc(32, 1);
  const seedIv = Buffer.alloc(12, 2);
  const seedAuthTag = Buffer.alloc(16, 3);

  async function insertEncounter(encounterId: string, playerId: string): Promise<void> {
    await pool.query(
      `INSERT INTO encounters(
         id, player_id, area_id, status, content_release_id, ruleset_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
         rng_counter, revision
       ) VALUES ($1, $2, $3, 'IN_BATTLE', $4, $5, $6, $7, $8, 1, 0, 0)`,
      [encounterId, playerId, areaId, releaseId, rulesetId, seedCiphertext, seedIv, seedAuthTag],
    );
  }

  await insertEncounter(correctionEncounterId, correctionPlayerId);
  await insertEncounter(cancelEncounterId, cancelPlayerId);
  await insertEncounter(deniedEncounterId, deniedPlayerId);

  async function insertBattle(
    state: BattleState,
    encounterId: string | null,
  ): Promise<BattleFixture> {
    await pool.query(
      `INSERT INTO battles(
         id, battle_type, status, content_release_id, ruleset_id, encounter_id,
         turn_number, version,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version, rng_counter
       ) VALUES ($1, $2, 'ACTIVE', $3, $4, $5, 0, 0, $6, $7, $8, 1, 0)`,
      [
        state.battleId,
        state.battleType,
        releaseId,
        rulesetId,
        encounterId,
        seedCiphertext,
        seedIv,
        seedAuthTag,
      ],
    );
    for (const side of state.sides) {
      await pool.query(
        `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id, result)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [randomUUID(), state.battleId, side.sideNo, side.controllerKind, side.playerId],
      );
    }
    await pool.query(
      `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
       VALUES ($1, 0, 1, $2::jsonb)`,
      [state.battleId, JSON.stringify(state)],
    );
    const player = state.combatants.find((entry) => entry.sideNo === 1);
    const move = player?.moves[0];
    const playerId = state.sides.find((side) => side.sideNo === 1)?.playerId;
    if (player === undefined || move === undefined || playerId === null || playerId === undefined) {
      throw new Error("Battle admin proof fixture is incomplete");
    }
    return {
      playerId,
      battleId: state.battleId,
      encounterId,
      participantId: player.participantId,
      moveSlot: move.slotNo,
      initialHp: player.currentHp,
      initialPp: move.ppCurrent ?? 0,
    };
  }

  const correctionBattleId = randomUUID();
  const correctionParticipantId = randomUUID();
  const correction = await insertBattle(
    wildBattleState({
      battleId: correctionBattleId,
      encounterId: correctionEncounterId,
      playerId: correctionPlayerId,
      releaseId,
      rulesetId,
      participantId: correctionParticipantId,
    }),
    correctionEncounterId,
  );
  const cancelBattleId = randomUUID();
  const cancelParticipantId = randomUUID();
  const cancellation = await insertBattle(
    wildBattleState({
      battleId: cancelBattleId,
      encounterId: cancelEncounterId,
      playerId: cancelPlayerId,
      releaseId,
      rulesetId,
      participantId: cancelParticipantId,
    }),
    cancelEncounterId,
  );
  const deniedBattleId = randomUUID();
  const deniedParticipantId = randomUUID();
  await insertBattle(
    wildBattleState({
      battleId: deniedBattleId,
      encounterId: deniedEncounterId,
      playerId: deniedPlayerId,
      releaseId,
      rulesetId,
      participantId: deniedParticipantId,
    }),
    deniedEncounterId,
  );
  const pvpBattleId = randomUUID();
  const pvpParticipantA = randomUUID();
  const pvp = await insertBattle(
    pvpBattleState({
      battleId: pvpBattleId,
      playerA: pvpPlayerA,
      playerB: pvpPlayerB,
      releaseId,
      rulesetId,
      participantA: pvpParticipantA,
    }),
    null,
  );

  const seniorRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SENIOR_ADMIN'`,
  );
  const supportRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SUPPORT'`,
  );
  const seniorRoleId = seniorRole.rows[0]?.id;
  const supportRoleId = supportRole.rows[0]?.id;
  if (seniorRoleId === undefined || supportRoleId === undefined) {
    throw new Error("Phase 12 Battle admin proof requires seeded admin roles");
  }

  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE')`,
    [
      globalPrincipalId,
      `phase12:battle-admin:${globalPrincipalId}`,
      supportPrincipalId,
      `phase12:battle-support:${supportPrincipalId}`,
    ],
  );
  await pool.query(
    `INSERT INTO admin_principal_roles(principal_id, role_id)
     VALUES ($1, $2), ($3, $4)`,
    [globalPrincipalId, seniorRoleId, supportPrincipalId, supportRoleId],
  );
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'GLOBAL', NULL), ($3, $4, 'PLAYER', $5)`,
    [randomUUID(), globalPrincipalId, randomUUID(), supportPrincipalId, correctionPlayerId],
  );

  const adminRepository = new PostgresAdminRepository(pool);
  const registry = createPhase12AdminOperationRegistry(adminRepository);
  const admin = new AdminService(registry, adminRepository);
  const battleRepository = new PostgresBattleAdminRepository(pool);
  const owner = new BattleAdminOwnerService(battleRepository, new PostgresBattleCancellation(pool));
  const battleAdmin = new AdminBattleOperationService(
    admin,
    owner,
    new PostgresAdminOperationCompletion(pool),
  );
  registerPhase12CBattleAdminOperations(registry, battleAdmin);

  const inspected = await battleAdmin.inspect({
    principalId: supportPrincipalId,
    playerId: correctionPlayerId,
    battleId: correctionBattleId,
  });
  if (
    inspected.status !== "ACTIVE" ||
    inspected.version !== 0 ||
    inspected.state?.battleId !== correctionBattleId
  ) {
    throw new Error("Scoped Battle inspect did not return the expected current state");
  }
  await expectRejected(
    battleAdmin.inspect({
      principalId: supportPrincipalId,
      playerId: deniedPlayerId,
      battleId: deniedBattleId,
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  const correctionPrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "battle.correct_state",
    input: {
      playerId: correctionPlayerId,
      battleId: correctionBattleId,
      participantId: correction.participantId,
      currentHp: correction.initialHp - 1,
      majorStatus: { key: "PARALYSIS", counter: null },
      movePp: { slotNo: correction.moveSlot, ppCurrent: correction.initialPp - 1 },
    },
    reason: "Repair a corrupted active Battle snapshot without changing Battle authority",
    expectedRevision: 0n,
    idempotencyKey: `battle-correct-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (correctionPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Battle correction must require explicit R3 confirmation");
  }
  await expectRejected(
    admin.apply(correctionPrepared.operation.id, globalPrincipalId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  await admin.confirm(correctionPrepared.operation.id, globalPrincipalId);
  const corrected = await admin.apply(correctionPrepared.operation.id, globalPrincipalId);
  if (
    corrected.status !== "APPLIED" ||
    corrected.result?.operationKind !== "CORRECT_STATE" ||
    corrected.result?.afterVersion !== 1
  ) {
    throw new Error("Battle correction did not complete through Admin Registry");
  }

  const correctionEvidence = await pool.query<{
    status: string;
    version: string;
    turn_number: number;
    rng_counter: string;
    snapshot_count: string;
    correction_events: string;
    reward_claims: string;
    state: unknown;
  }>(
    `SELECT battle.status,
            battle.version::text,
            battle.turn_number,
            battle.rng_counter::text,
            (SELECT count(*)::text FROM battle_state_snapshots WHERE battle_id = battle.id) AS snapshot_count,
            (SELECT count(*)::text FROM battle_events
             WHERE battle_id = battle.id
               AND causation_id = $2::uuid
               AND event_type = 'BattleStateCorrected') AS correction_events,
            (SELECT count(*)::text FROM battle_reward_claims WHERE battle_id = battle.id) AS reward_claims,
            snapshot.state
     FROM battles battle
     JOIN battle_state_snapshots snapshot
       ON snapshot.battle_id = battle.id AND snapshot.version = battle.version
     WHERE battle.id = $1::uuid`,
    [correctionBattleId, correctionPrepared.operation.id],
  );
  const correctionRow = correctionEvidence.rows[0];
  if (
    correctionRow?.status !== "ACTIVE" ||
    correctionRow.version !== "1" ||
    correctionRow.turn_number !== 0 ||
    correctionRow.rng_counter !== "0" ||
    correctionRow.snapshot_count !== "2" ||
    correctionRow.correction_events !== "1" ||
    correctionRow.reward_claims !== "0"
  ) {
    throw new Error(`Battle correction evidence is inconsistent: ${JSON.stringify(correctionRow)}`);
  }
  const correctedState = correctionRow.state as BattleState;
  const correctedCombatant = correctedState.combatants.find(
    (entry) => entry.participantId === correction.participantId,
  );
  if (
    correctedCombatant?.currentHp !== correction.initialHp - 1 ||
    correctedCombatant.majorStatus?.key !== "PARALYSIS" ||
    correctedCombatant.moves.find((move) => move.slotNo === correction.moveSlot)?.ppCurrent !==
      correction.initialPp - 1
  ) {
    throw new Error("Battle correction did not persist the exact allowlisted state changes");
  }

  const stalePrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "battle.correct_state",
    input: {
      playerId: correctionPlayerId,
      battleId: correctionBattleId,
      participantId: correction.participantId,
      currentHp: correction.initialHp,
    },
    reason: "Prove stale Battle CAS rejection",
    expectedRevision: 0n,
    idempotencyKey: `battle-stale-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(stalePrepared.operation.id, globalPrincipalId);
  await expectRejected(
    admin.apply(stalePrepared.operation.id, globalPrincipalId),
    ADMIN_ERROR_CODES.REVISION_CONFLICT,
  );

  const invalidPpPrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "battle.correct_state",
    input: {
      playerId: correctionPlayerId,
      battleId: correctionBattleId,
      participantId: correction.participantId,
      movePp: { slotNo: correction.moveSlot, ppCurrent: 99 },
    },
    reason: "Prove Battle PP max remains authoritative",
    expectedRevision: 1n,
    idempotencyKey: `battle-invalid-pp-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(invalidPpPrepared.operation.id, globalPrincipalId);
  await expectRejected(
    admin.apply(invalidPpPrepared.operation.id, globalPrincipalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  await expectRejected(
    admin.prepareMutation({
      principalId: globalPrincipalId,
      operationType: "battle.correct_state",
      input: {
        playerId: correctionPlayerId,
        battleId: correctionBattleId,
        participantId: correction.participantId,
        currentHp: 0,
      },
      reason: "This must fail before it can manufacture a faint",
      expectedRevision: 1n,
      idempotencyKey: `battle-zero-hp-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.INVALID_INPUT,
  );

  const cancelCorrelationId = randomUUID();
  const cancelPrepared = await admin.prepareMutation({
    principalId: globalPrincipalId,
    operationType: "battle.force_cancel",
    input: { playerId: cancelPlayerId, battleId: cancelBattleId },
    reason: "Recover a stuck Battle without manufacturing a winner",
    expectedRevision: 0n,
    idempotencyKey: `battle-cancel-${randomUUID()}`,
    correlationId: cancelCorrelationId,
  });
  if (cancelPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Battle force-cancel must require explicit R3 confirmation");
  }
  await admin.confirm(cancelPrepared.operation.id, globalPrincipalId);

  const ownerFirst = await owner.forceCancel({
    playerId: cancelPlayerId,
    battleId: cancelBattleId,
    expectedVersion: 0,
    idempotencyKey: cancelPrepared.operation.id,
    correlationId: cancelCorrelationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: cancelPrepared.operation.id,
      reason: cancelPrepared.operation.reason ?? "",
      actorType: "ADMIN",
      actorId: globalPrincipalId,
    },
  });
  if (
    !ownerFirst.ok ||
    ownerFirst.value.replayed ||
    ownerFirst.value.afterVersion !== 1 ||
    !ownerFirst.value.encounterNeedsClose
  ) {
    throw new Error("Battle owner crash-window setup did not cancel exactly once");
  }

  const recovered = await admin.apply(cancelPrepared.operation.id, globalPrincipalId);
  if (
    recovered.status !== "APPLIED" ||
    recovered.result?.ownerReplayed !== true ||
    recovered.result?.afterVersion !== 1 ||
    recovered.result?.encounterNeedsClose !== true
  ) {
    throw new Error("Battle admin crash recovery did not replay durable owner evidence");
  }

  const cancelEvidence = await pool.query<{
    status: string;
    version: string;
    ended_at: Date | null;
    encounter_status: string;
    snapshot_count: string;
    cancel_events: string;
    cancelled_sides: string;
    reward_claims: string;
    change_count: string;
    audit_count: string;
  }>(
    `SELECT battle.status,
            battle.version::text,
            battle.ended_at,
            encounter.status AS encounter_status,
            (SELECT count(*)::text FROM battle_state_snapshots WHERE battle_id = battle.id) AS snapshot_count,
            (SELECT count(*)::text FROM battle_events
             WHERE battle_id = battle.id
               AND causation_id = $2::uuid
               AND event_type = 'BattleEnded') AS cancel_events,
            (SELECT count(*)::text FROM battle_sides
             WHERE battle_id = battle.id AND result = 'CANCELLED') AS cancelled_sides,
            (SELECT count(*)::text FROM battle_reward_claims WHERE battle_id = battle.id) AS reward_claims,
            (SELECT count(*)::text FROM admin_operation_changes
             WHERE admin_operation_id = $2::uuid) AS change_count,
            (SELECT count(*)::text FROM audit_events
             WHERE causation_id = $2::uuid) AS audit_count
     FROM battles battle
     JOIN encounters encounter ON encounter.id = battle.encounter_id
     WHERE battle.id = $1::uuid`,
    [cancelBattleId, cancelPrepared.operation.id],
  );
  const cancelRow = cancelEvidence.rows[0];
  if (
    cancelRow?.status !== "CANCELLED" ||
    cancelRow.version !== "1" ||
    cancelRow.ended_at === null ||
    cancelRow.encounter_status !== "IN_BATTLE" ||
    cancelRow.snapshot_count !== "2" ||
    cancelRow.cancel_events !== "1" ||
    cancelRow.cancelled_sides !== "2" ||
    cancelRow.reward_claims !== "0" ||
    cancelRow.change_count !== "1" ||
    cancelRow.audit_count !== "1"
  ) {
    throw new Error(`Battle cancellation evidence is inconsistent: ${JSON.stringify(cancelRow)}`);
  }

  const semanticDrift = await owner.forceCancel({
    playerId: cancelPlayerId,
    battleId: cancelBattleId,
    expectedVersion: 1,
    idempotencyKey: cancelPrepared.operation.id,
    correlationId: cancelCorrelationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: cancelPrepared.operation.id,
      reason: cancelPrepared.operation.reason ?? "",
      actorType: "ADMIN",
      actorId: globalPrincipalId,
    },
  });
  expectOwnerError(semanticDrift, "FINGERPRINT_MISMATCH", "Battle force-cancel semantic drift");

  const terminalCorrection = await owner.correctState({
    playerId: cancelPlayerId,
    battleId: cancelBattleId,
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: randomUUID(),
      reason: "Terminal Battle must remain immutable to correction",
      actorType: "ADMIN",
      actorId: globalPrincipalId,
    },
    correction: { participantId: cancellation.participantId, currentHp: cancellation.initialHp },
  });
  expectOwnerError(
    terminalCorrection,
    "INVALID_STATE_TRANSITION",
    "Terminal Battle state correction",
  );

  const pvpCorrection = await owner.correctState({
    playerId: pvp.playerId,
    battleId: pvp.battleId,
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: randomUUID(),
      reason: "PVP subject mutation must be rejected",
      actorType: "ADMIN",
      actorId: globalPrincipalId,
    },
    correction: { participantId: pvp.participantId, currentHp: pvp.initialHp - 1 },
  });
  expectOwnerError(pvpCorrection, "ACTION_INVALID", "PVP Battle correction");

  const pvpCancel = await owner.forceCancel({
    playerId: pvp.playerId,
    battleId: pvp.battleId,
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: randomUUID(),
      reason: "PVP subject cancellation must be rejected",
      actorType: "ADMIN",
      actorId: globalPrincipalId,
    },
  });
  expectOwnerError(pvpCancel, "ACTION_INVALID", "PVP Battle force-cancel");

  console.log(
    `Phase 12 Battle Admin E2E complete: corrected ${correctionBattleId}, cancelled ${cancelBattleId}, PVP protected ${pvpBattleId}`,
  );
} finally {
  await pool.end();
}
