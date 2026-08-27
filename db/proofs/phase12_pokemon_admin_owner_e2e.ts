import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { RulesetConfigSchema } from "../../src/modules/catalog/contracts.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { PokemonAdminService } from "../../src/modules/pokemon/admin-service.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresPokemonAdminRepository } from "../../src/platform/pokemon/postgres-pokemon-admin-repository.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";

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

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const effectId = randomUUID();
  const playerId = randomUUID();
  const otherPlayerId = randomUUID();
  const principalId = randomUUID();
  const pokemonRosterId = randomUUID();
  const pokemonOccupiedId = randomUUID();
  const pokemonMechanicsId = randomUUID();
  const pokemonArchiveId = randomUUID();
  const pokemonBattleId = randomUUID();
  const pokemonOtherPlayerId = randomUUID();

  const rulesConfig = RulesetConfigSchema.parse({
    schemaVersion: 1,
    battle: {
      statModel: "SIX_STATS",
      physicalSpecialByMove: true,
      ivEnabled: true,
      evEnabled: false,
      natureEnabled: false,
      maxMoves: 4,
      ppEnabled: true,
      criticalMultiplierBasisPoints: 15_000,
      accuracyEvasionEnabled: true,
    },
    capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 10_000 },
    defeat: { automaticMoneyLoss: false },
    narrative: { authority: "N0_FLAVOR_ONLY" },
  });

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, $3::jsonb, 'DRAFT')`,
    [rulesetId, `phase12-pokemon-admin-${rulesetId}`, JSON.stringify(rulesConfig)],
  );
  await pool.query(
    `UPDATE rulesets
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"proof":true}'::jsonb,
         config_fingerprint = repeat('e', 64)
     WHERE id = $1`,
    [rulesetId],
  );
  await pool.query(`UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
    rulesetId,
  ]);

  const nextRelease = await pool.query<{ release_no: string }>(
    `SELECT (COALESCE(MAX(release_no), 900000) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = nextRelease.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate proof release number");
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 12 Pokemon Admin Proof', 'DRAFT', $3)`,
    [releaseId, releaseNo, rulesetId],
  );

  // Content-release children must be materialized while the release is still DRAFT.
  await pool.query(`INSERT INTO pokemon_types(id, slug) VALUES ($1, $2)`, [
    typeId,
    `phase12-type-${typeId}`,
  ]);
  await pool.query(
    `INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 32000, $2)`,
    [speciesId, `phase12-species-${speciesId}`],
  );
  await pool.query(`INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')`, [
    formId,
    speciesId,
  ]);
  await pool.query(
    `INSERT INTO pokemon_type_revisions(id, content_release_id, type_id, display_name)
     VALUES ($1, $2, $3, 'Proof Type')`,
    [randomUUID(), releaseId, typeId],
  );
  await pool.query(
    `INSERT INTO pokemon_species_revisions(
       id, content_release_id, species_id, display_name, catch_rate, base_exp
     ) VALUES ($1, $2, $3, 'Proofmon', 45, 64)`,
    [randomUUID(), releaseId, speciesId],
  );
  await pool.query(
    `INSERT INTO pokemon_form_revisions(
       id, content_release_id, form_id, display_name, type1_id,
       base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     ) VALUES ($1, $2, $3, 'Proofmon', $4, 45, 49, 49, 65, 65, 45)`,
    [randomUUID(), releaseId, formId, typeId],
  );
  await pool.query(`INSERT INTO effects(id, slug) VALUES ($1, $2)`, [
    effectId,
    `phase12-effect-${effectId}`,
  ]);

  await pool.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"proof":true}'::jsonb,
         content_fingerprint = repeat('f', 64)
     WHERE id = $1`,
    [releaseId],
  );
  await pool.query(
    `UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [releaseId],
  );
  await pool.query(
    `INSERT INTO content_release_pointers(pointer_key, content_release_id)
     VALUES ('ACTIVE', $1)
     ON CONFLICT (pointer_key) DO UPDATE
     SET content_release_id = EXCLUDED.content_release_id,
         revision = content_release_pointers.revision + 1,
         updated_at = now()`,
    [releaseId],
  );

  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`, [
    playerId,
    otherPlayerId,
  ]);
  const pokemonRows = [
    [pokemonRosterId, playerId, 10],
    [pokemonOccupiedId, playerId, 19],
    [pokemonMechanicsId, playerId, 10],
    [pokemonArchiveId, playerId, 19],
    [pokemonBattleId, playerId, 19],
    [pokemonOtherPlayerId, otherPlayerId, 19],
  ] as const;
  for (const [pokemonId, ownerId, hp] of pokemonRows) {
    await pool.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, level, current_hp, origin_type, origin_id
       ) VALUES ($1, $2, $3, 5, $4, 'ADMIN_PROOF', $5)`,
      [pokemonId, ownerId, formId, hp, randomUUID()],
    );
    await pool.query(
      `INSERT INTO pokemon_training_values(
         pokemon_instance_id, iv_hp, iv_attack, iv_defense, iv_sp_attack, iv_sp_defense, iv_speed
       ) VALUES ($1, 0, 0, 0, 0, 0, 0)`,
      [pokemonId],
    );
  }
  await pool.query(
    `INSERT INTO pokemon_roster_slots(pokemon_instance_id, player_id, placement_kind, box_no, slot_no)
     VALUES
       ($1, $6, 'TEAM', NULL, 1),
       ($2, $6, 'TEAM', NULL, 2),
       ($3, $6, 'TEAM', NULL, 3),
       ($4, $6, 'TEAM', NULL, 4),
       ($5, $6, 'TEAM', NULL, 5),
       ($7, $8, 'TEAM', NULL, 1)`,
    [
      pokemonRosterId,
      pokemonOccupiedId,
      pokemonMechanicsId,
      pokemonArchiveId,
      pokemonBattleId,
      playerId,
      pokemonOtherPlayerId,
      otherPlayerId,
    ],
  );
  await pool.query(
    `INSERT INTO active_effects(
       id, effect_id, content_release_id, pokemon_instance_id, source_type, source_id
     ) VALUES ($1, $2, $3, $4, 'ADMIN_PROOF', $5)`,
    [randomUUID(), effectId, releaseId, pokemonArchiveId, randomUUID()],
  );

  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'POKEMON_ADMIN'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error("POKEMON_ADMIN role must be seeded before proof");
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')`,
    [principalId, `phase12:pokemon-admin:${principalId}`],
  );
  await pool.query(`INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`, [
    principalId,
    roleId,
  ]);
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'PLAYER', $3)`,
    [randomUUID(), principalId, playerId],
  );

  const adminRepository = new PostgresAdminRepository(pool);
  const pokemonOwner = new PokemonAdminService(new PostgresPokemonAdminRepository(pool));
  const domain = new AdminDomainOperationService(
    new EconomyService(new PostgresEconomyRepository(pool)),
    new ProgressionService(new PostgresProgressionRepository(pool)),
    new PostgresAdminOperationCompletion(pool),
    pokemonOwner,
  );
  const registry = registerPhase12CDomainAdminOperations(
    createPhase12AdminOperationRegistry(adminRepository),
    domain,
  );
  const admin = new AdminService(registry, adminRepository);

  const rosterCorrelationId = randomUUID();
  const rosterPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.roster.move",
    input: {
      playerId,
      pokemonInstanceId: pokemonRosterId,
      target: { placementKind: "BOX", boxNo: 1, slotNo: 1 },
    },
    reason: "Move support Pokemon to box",
    expectedRevision: 0n,
    idempotencyKey: `pokemon-roster-${randomUUID()}`,
    correlationId: rosterCorrelationId,
  });
  if (rosterPrepared.operation.status !== "READY") {
    throw new Error("R1 roster move should be READY after validation");
  }
  const rosterApplied = await admin.apply(rosterPrepared.operation.id, principalId);
  if (
    rosterApplied.status !== "APPLIED" ||
    rosterApplied.result?.operationKind !== "ROSTER_MOVE" ||
    rosterApplied.result?.afterRevision !== "1"
  ) {
    throw new Error("Roster admin operation did not apply through Pokemon owner");
  }
  const rosterState = await pool.query<{
    revision: string;
    placement_kind: string;
    box_no: number | null;
    slot_no: number;
    claim_count: string;
    history_count: string;
  }>(
    `SELECT pokemon.revision::text, roster.placement_kind, roster.box_no, roster.slot_no,
            (SELECT count(*)::text FROM pokemon_admin_operation_claims
             WHERE idempotency_key = $3) AS claim_count,
            (SELECT count(*)::text FROM pokemon_history_events
             WHERE pokemon_instance_id = $1 AND event_type = 'ADMIN_ROSTER_MOVED') AS history_count
     FROM pokemon_instances pokemon
     JOIN pokemon_roster_slots roster ON roster.pokemon_instance_id = pokemon.id
     WHERE pokemon.id = $1 AND pokemon.owner_player_id = $2`,
    [pokemonRosterId, playerId, rosterPrepared.operation.id],
  );
  const rosterRow = rosterState.rows[0];
  if (
    rosterRow?.revision !== "1" ||
    rosterRow.placement_kind !== "BOX" ||
    rosterRow.box_no !== 1 ||
    rosterRow.slot_no !== 1 ||
    rosterRow.claim_count !== "1" ||
    rosterRow.history_count !== "1"
  ) {
    throw new Error("Roster owner left incoherent persisted state");
  }

  const ownerReplay = await pokemonOwner.moveRoster({
    playerId,
    pokemonInstanceId: pokemonRosterId,
    expectedRevision: 0n,
    idempotencyKey: rosterPrepared.operation.id,
    correlationId: rosterCorrelationId,
    target: { placementKind: "BOX", boxNo: 1, slotNo: 1 },
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: rosterPrepared.operation.id,
      reason: "Move support Pokemon to box",
      actorType: "ADMIN",
      actorId: principalId,
    },
  });
  if (!ownerReplay.ok || !ownerReplay.value.replayed) {
    throw new Error("Pokemon owner did not replay its durable claim");
  }
  const semanticConflict = await pokemonOwner.moveRoster({
    playerId,
    pokemonInstanceId: pokemonRosterId,
    expectedRevision: 0n,
    idempotencyKey: rosterPrepared.operation.id,
    correlationId: rosterCorrelationId,
    target: { placementKind: "BOX", boxNo: 1, slotNo: 2 },
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: rosterPrepared.operation.id,
      reason: "Move support Pokemon to box",
      actorType: "ADMIN",
      actorId: principalId,
    },
  });
  if (semanticConflict.ok || semanticConflict.error.code !== "FINGERPRINT_MISMATCH") {
    throw new Error("Pokemon owner accepted semantic idempotency drift");
  }

  const stalePrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.roster.move",
    input: {
      playerId,
      pokemonInstanceId: pokemonRosterId,
      target: { placementKind: "BOX", boxNo: 1, slotNo: 3 },
    },
    reason: "Stale revision proof",
    expectedRevision: 0n,
    idempotencyKey: `pokemon-stale-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await expectRejected(
    admin.apply(stalePrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.REVISION_CONFLICT,
  );

  const occupiedPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.roster.move",
    input: {
      playerId,
      pokemonInstanceId: pokemonRosterId,
      target: { placementKind: "TEAM", boxNo: null, slotNo: 2 },
    },
    reason: "Occupied slot proof",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-occupied-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await expectRejected(
    admin.apply(occupiedPrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  await expectRejected(
    admin.prepareMutation({
      principalId,
      operationType: "pokemon.roster.move",
      input: {
        playerId: otherPlayerId,
        pokemonInstanceId: pokemonOtherPlayerId,
        target: { placementKind: "BOX", boxNo: 1, slotNo: 1 },
      },
      reason: "BOLA scope proof",
      expectedRevision: 0n,
      idempotencyKey: `pokemon-bola-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  const hpPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.hp.correct",
    input: { playerId, pokemonInstanceId: pokemonMechanicsId, currentHp: 15 },
    reason: "Correct support HP after incident",
    expectedRevision: 0n,
    idempotencyKey: `pokemon-hp-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (hpPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("R3 HP correction must require confirmation");
  }
  await expectRejected(
    admin.apply(hpPrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  const hpConfirmed = await admin.confirm(hpPrepared.operation.id, principalId);
  if (hpConfirmed.status !== "READY") throw new Error("Confirmed HP correction should become READY");
  const hpApplied = await admin.apply(hpPrepared.operation.id, principalId);
  if (hpApplied.result?.afterRevision !== "1") throw new Error("HP correction did not advance CAS");
  const hpRow = await pool.query<{ current_hp: number; revision: string }>(
    `SELECT current_hp, revision::text FROM pokemon_instances WHERE id = $1`,
    [pokemonMechanicsId],
  );
  if (hpRow.rows[0]?.current_hp !== 15 || hpRow.rows[0]?.revision !== "1") {
    throw new Error("HP correction did not persist exact owner state");
  }

  const invalidHp = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.hp.correct",
    input: { playerId, pokemonInstanceId: pokemonMechanicsId, currentHp: 20 },
    reason: "Reject HP over derived maximum",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-hp-max-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(invalidHp.operation.id, principalId);
  await expectRejected(
    admin.apply(invalidHp.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );
  const hpAfterReject = await pool.query<{ current_hp: number; revision: string }>(
    `SELECT current_hp, revision::text FROM pokemon_instances WHERE id = $1`,
    [pokemonMechanicsId],
  );
  if (hpAfterReject.rows[0]?.current_hp !== 15 || hpAfterReject.rows[0]?.revision !== "1") {
    throw new Error("Rejected HP correction left partial state");
  }

  const statusPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.status.correct",
    input: { playerId, pokemonInstanceId: pokemonMechanicsId, status: "SLEEP", counter: 3 },
    reason: "Repair persistent battle status",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-status-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(statusPrepared.operation.id, principalId);
  const statusApplied = await admin.apply(statusPrepared.operation.id, principalId);
  if (statusApplied.result?.afterRevision !== "2") {
    throw new Error("Status correction did not advance aggregate revision");
  }
  const statusRows = await pool.query<{ condition_key: string; source_type: string }>(
    `SELECT condition_key, source_type
     FROM pokemon_persistent_conditions
     WHERE pokemon_instance_id = $1
       AND condition_key IN ('BURN','POISON','PARALYSIS','SLEEP','FREEZE')`,
    [pokemonMechanicsId],
  );
  if (
    statusRows.rows.length !== 1 ||
    statusRows.rows[0]?.condition_key !== "SLEEP" ||
    statusRows.rows[0]?.source_type !== "ADMIN_OPERATION"
  ) {
    throw new Error("Status correction persisted an invalid major-status set");
  }

  const battleId = randomUUID();
  const battleSideId = randomUUID();
  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
     ) VALUES ($1, 'WILD', 'ACTIVE', $2, $3, $4, $5, $6, 1)`,
    [
      battleId,
      releaseId,
      rulesetId,
      Buffer.alloc(32, 1),
      Buffer.alloc(12, 2),
      Buffer.alloc(16, 3),
    ],
  );
  await pool.query(
    `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
     VALUES ($1, $2, 1, 'PLAYER', $3)`,
    [battleSideId, battleId, playerId],
  );
  await pool.query(
    `INSERT INTO battle_participants(
       id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
       roster_position, snapshot
     ) VALUES ($1, $2, $3, $4, 'PLAYER_POKEMON', 1, '{}'::jsonb)`,
    [randomUUID(), battleId, battleSideId, pokemonBattleId],
  );
  const battleBlocked = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.roster.move",
    input: {
      playerId,
      pokemonInstanceId: pokemonBattleId,
      target: { placementKind: "BOX", boxNo: 1, slotNo: 50 },
    },
    reason: "Active battle safety proof",
    expectedRevision: 0n,
    idempotencyKey: `pokemon-battle-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await expectRejected(
    admin.apply(battleBlocked.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );
  const battlePokemonState = await pool.query<{ revision: string; placement_kind: string }>(
    `SELECT pokemon.revision::text, roster.placement_kind
     FROM pokemon_instances pokemon
     JOIN pokemon_roster_slots roster ON roster.pokemon_instance_id = pokemon.id
     WHERE pokemon.id = $1`,
    [pokemonBattleId],
  );
  if (
    battlePokemonState.rows[0]?.revision !== "0" ||
    battlePokemonState.rows[0]?.placement_kind !== "TEAM"
  ) {
    throw new Error("Battle-blocked Pokemon mutation left partial state");
  }

  const archivePrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.archive",
    input: { playerId, pokemonInstanceId: pokemonArchiveId },
    reason: "Archive duplicated Pokemon instance",
    expectedRevision: 0n,
    idempotencyKey: `pokemon-archive-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (archivePrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Pokemon archive must require confirmation");
  }
  await admin.confirm(archivePrepared.operation.id, principalId);
  const archived = await admin.apply(archivePrepared.operation.id, principalId);
  if (archived.result?.afterRevision !== "1") throw new Error("Archive did not advance CAS");
  const archiveState = await pool.query<{
    status: string;
    archived_at: Date | null;
    revision: string;
    roster_count: string;
    effect_count: string;
    claim_count: string;
  }>(
    `SELECT pokemon.status, pokemon.archived_at, pokemon.revision::text,
            (SELECT count(*)::text FROM pokemon_roster_slots WHERE pokemon_instance_id = $1) AS roster_count,
            (SELECT count(*)::text FROM active_effects WHERE pokemon_instance_id = $1) AS effect_count,
            (SELECT count(*)::text FROM pokemon_admin_operation_claims
             WHERE idempotency_key = $2) AS claim_count
     FROM pokemon_instances pokemon WHERE pokemon.id = $1`,
    [pokemonArchiveId, archivePrepared.operation.id],
  );
  const archiveRow = archiveState.rows[0];
  if (
    archiveRow?.status !== "ARCHIVED" ||
    archiveRow.archived_at === null ||
    archiveRow.revision !== "1" ||
    archiveRow.roster_count !== "0" ||
    archiveRow.effect_count !== "0" ||
    archiveRow.claim_count !== "1"
  ) {
    throw new Error("Pokemon archive did not preserve soft-delete invariants");
  }

  await pool
    .query(
      `UPDATE pokemon_admin_operation_claims SET result = '{}'::jsonb
       WHERE idempotency_key = $1`,
      [archivePrepared.operation.id],
    )
    .then(
      () => {
        throw new Error("Pokemon admin claim update should be blocked by DB trigger");
      },
      () => undefined,
    );

  console.log(
    "Phase 12 Pokemon Admin Owner E2E passed: R1/R3 policy, CAS, scope, replay, battle safety, HP/status and soft archive are durable",
  );
} finally {
  await pool.end();
}
