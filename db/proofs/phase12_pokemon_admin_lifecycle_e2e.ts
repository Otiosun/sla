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
import { PostgresPokemonLifecycleAdminRepository } from "../../src/platform/pokemon/postgres-pokemon-lifecycle-admin-repository.js";
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
  const evolvedFormId = randomUUID();
  const abilityId = randomUUID();
  const natureId = randomUUID();
  const startMoveId = randomUUID();
  const levelMoveId = randomUUID();
  const playerId = randomUUID();
  const principalId = randomUUID();

  const rulesConfig = RulesetConfigSchema.parse({
    schemaVersion: 1,
    battle: {
      statModel: "SIX_STATS",
      physicalSpecialByMove: true,
      ivEnabled: true,
      evEnabled: false,
      natureEnabled: true,
      maxMoves: 4,
      ppEnabled: true,
      criticalMultiplierBasisPoints: 15_000,
      accuracyEvasionEnabled: true,
    },
    capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 10_000 },
    defeat: { automaticMoneyLoss: false },
    narrative: { authority: "N0_FLAVOR_ONLY" },
    progression: {
      pokemon: {
        xpCurve: "CUBIC_DELTA_V1",
        battleRewardModel: "BASE_EXP_LEVEL_DIV_7_V1",
        rewardRecipient: "ACTIVE_WINNER_V1",
        levelCap: 100,
        hpOnLevelUp: "ADD_MAX_HP_DELTA_IF_ALIVE_V1",
        fullMoveSlotsPolicy: "PENDING_CHOICE_V1",
        autoLevelEvolution: true,
      },
      trainer: {
        visiblePointsName: "Insígnia",
        levelCurve: "LINEAR_100_V1",
        levelCap: 100,
        pointsPerWonBattle: 100,
        unlocks: [{ level: 10, unlockKey: "tournament.eligible" }],
      },
    },
  });

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, $3::jsonb, 'DRAFT')`,
    [rulesetId, `phase12-pokemon-lifecycle-${rulesetId}`, JSON.stringify(rulesConfig)],
  );
  await pool.query(
    `UPDATE rulesets
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"proof":true}'::jsonb,
         config_fingerprint = repeat('a', 64)
     WHERE id = $1`,
    [rulesetId],
  );
  await pool.query(`UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
    rulesetId,
  ]);

  const nextRelease = await pool.query<{ release_no: string }>(
    `SELECT (COALESCE(MAX(release_no), 900100) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = nextRelease.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate lifecycle proof release number");
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 12 Pokemon Lifecycle Proof', 'DRAFT', $3)`,
    [releaseId, releaseNo, rulesetId],
  );

  await pool.query(`INSERT INTO pokemon_types(id, slug) VALUES ($1, $2)`, [
    typeId,
    `phase12-lifecycle-type-${typeId}`,
  ]);
  await pool.query(`INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 32001, $2)`, [
    speciesId,
    `phase12-lifecycle-species-${speciesId}`,
  ]);
  await pool.query(
    `INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'base'), ($3, $2, 'evolved')`,
    [formId, speciesId, evolvedFormId],
  );
  await pool.query(`INSERT INTO abilities(id, slug) VALUES ($1, $2)`, [
    abilityId,
    `phase12-lifecycle-ability-${abilityId}`,
  ]);
  await pool.query(`INSERT INTO natures(id, slug) VALUES ($1, $2)`, [
    natureId,
    `phase12-lifecycle-nature-${natureId}`,
  ]);
  await pool.query(`INSERT INTO moves(id, slug) VALUES ($1, $2), ($3, $4)`, [
    startMoveId,
    `phase12-start-move-${startMoveId}`,
    levelMoveId,
    `phase12-level-move-${levelMoveId}`,
  ]);
  await pool.query(
    `INSERT INTO pokemon_type_revisions(id, content_release_id, type_id, display_name)
     VALUES ($1, $2, $3, 'Proof Type')`,
    [randomUUID(), releaseId, typeId],
  );
  await pool.query(
    `INSERT INTO pokemon_species_revisions(
       id, content_release_id, species_id, display_name, catch_rate, base_exp
     ) VALUES ($1, $2, $3, 'Lifecyclemon', 45, 64)`,
    [randomUUID(), releaseId, speciesId],
  );
  await pool.query(
    `INSERT INTO pokemon_form_revisions(
       id, content_release_id, form_id, display_name, type1_id,
       base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     ) VALUES
       ($1, $2, $3, 'Lifecyclemon', $5, 45, 49, 49, 65, 65, 45),
       ($4, $2, $6, 'Lifecyclemon Evolved', $5, 60, 62, 63, 80, 80, 60)`,
    [randomUUID(), releaseId, formId, randomUUID(), typeId, evolvedFormId],
  );
  await pool.query(
    `INSERT INTO ability_revisions(id, content_release_id, ability_id, display_name)
     VALUES ($1, $2, $3, 'Proof Ability')`,
    [randomUUID(), releaseId, abilityId],
  );
  await pool.query(
    `INSERT INTO nature_revisions(
       id, content_release_id, nature_id, display_name, increased_stat, decreased_stat
     ) VALUES ($1, $2, $3, 'Proof Nature', 'ATTACK', 'DEFENSE')`,
    [randomUUID(), releaseId, natureId],
  );
  await pool.query(
    `INSERT INTO move_revisions(
       id, content_release_id, move_id, display_name, type_id, category,
       power, accuracy, max_pp
     ) VALUES
       ($1, $2, $3, 'Proof Start Move', $5, 'PHYSICAL', 40, 100, 35),
       ($4, $2, $6, 'Proof Level Move', $5, 'SPECIAL', 50, 100, 25)`,
    [randomUUID(), releaseId, startMoveId, randomUUID(), typeId, levelMoveId],
  );
  await pool.query(
    `INSERT INTO pokemon_form_ability_options(
       id, content_release_id, form_id, ability_id, slot_kind
     ) VALUES ($1, $2, $3, $4, 'PRIMARY')`,
    [randomUUID(), releaseId, formId, abilityId],
  );
  await pool.query(
    `INSERT INTO move_learnset_entries(
       id, content_release_id, form_id, move_id, learn_method, learn_level
     ) VALUES
       ($1, $2, $3, $4, 'START', NULL),
       ($5, $2, $3, $6, 'LEVEL', 6)`,
    [randomUUID(), releaseId, formId, startMoveId, randomUUID(), levelMoveId],
  );
  await pool.query(
    `INSERT INTO evolution_rules(
       id, content_release_id, from_form_id, to_form_id, trigger_kind, trigger_config
     ) VALUES ($1, $2, $3, $4, 'LEVEL', '{"level":6}'::jsonb)`,
    [randomUUID(), releaseId, formId, evolvedFormId],
  );

  await pool.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"proof":true}'::jsonb,
         content_fingerprint = repeat('b', 64)
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

  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [playerId]);
  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'POKEMON_ADMIN'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error("POKEMON_ADMIN role must be seeded before proof");
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')`,
    [principalId, `phase12:pokemon-lifecycle:${principalId}`],
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
  const lifecycle = new PostgresPokemonLifecycleAdminRepository(pool);
  const pokemonOwner = new PokemonAdminService(
    new PostgresPokemonAdminRepository(pool),
    undefined,
    lifecycle,
  );
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

  const createCorrelationId = randomUUID();
  const createPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.create",
    input: { playerId, formId, level: 5 },
    reason: "Restore missing owned Pokemon after support incident",
    idempotencyKey: `pokemon-create-${randomUUID()}`,
    correlationId: createCorrelationId,
  });
  if (createPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Pokemon create must require R3 confirmation");
  }
  await expectRejected(
    admin.apply(createPrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  await admin.confirm(createPrepared.operation.id, principalId);
  const createApplied = await admin.apply(createPrepared.operation.id, principalId);
  if (createApplied.status !== "APPLIED" || createApplied.result?.operationKind !== "CREATE") {
    throw new Error("Pokemon create did not apply through lifecycle owner");
  }
  const createClaim = await pool.query<{
    pokemon_instance_id: string;
    request_fingerprint: string;
  }>(
    `SELECT pokemon_instance_id, request_fingerprint
     FROM pokemon_admin_create_claims WHERE idempotency_key = $1`,
    [createPrepared.operation.id],
  );
  const pokemonInstanceId = createClaim.rows[0]?.pokemon_instance_id;
  if (pokemonInstanceId === undefined) throw new Error("Pokemon create claim was not persisted");

  const created = await pool.query<{
    form_id: string;
    level: number;
    xp: string;
    current_hp: number;
    revision: string;
    ability_id: string | null;
    nature_id: string | null;
    move_count: string;
    placement_kind: string;
    slot_no: number;
    pokedex_caught: string;
    history_count: string;
  }>(
    `SELECT instance.form_id, instance.level, instance.xp::text, instance.current_hp,
            instance.revision::text, instance.ability_id, training.nature_id,
            (SELECT count(*)::text FROM pokemon_move_slots WHERE pokemon_instance_id = instance.id) AS move_count,
            roster.placement_kind, roster.slot_no,
            (SELECT caught_count::text FROM player_pokedex_species
             WHERE player_id = $2 AND species_id = $3) AS pokedex_caught,
            (SELECT count(*)::text FROM pokemon_history_events
             WHERE pokemon_instance_id = instance.id AND event_type = 'ADMIN_CREATED') AS history_count
     FROM pokemon_instances instance
     JOIN pokemon_training_values training ON training.pokemon_instance_id = instance.id
     JOIN pokemon_roster_slots roster ON roster.pokemon_instance_id = instance.id
     WHERE instance.id = $1 AND instance.owner_player_id = $2`,
    [pokemonInstanceId, playerId, speciesId],
  );
  const createdRow = created.rows[0];
  if (
    createdRow?.form_id !== formId ||
    createdRow.level !== 5 ||
    createdRow.xp !== "0" ||
    createdRow.current_hp <= 0 ||
    createdRow.revision !== "0" ||
    createdRow.ability_id !== abilityId ||
    createdRow.nature_id !== natureId ||
    createdRow.move_count !== "1" ||
    createdRow.placement_kind !== "TEAM" ||
    createdRow.slot_no !== 1 ||
    createdRow.pokedex_caught !== "1" ||
    createdRow.history_count !== "1"
  ) {
    throw new Error("Pokemon create did not persist a coherent generated bundle");
  }
  const createdHp = createdRow.current_hp;

  const createReplay = await pokemonOwner.createPokemon({
    playerId,
    formId,
    level: 5,
    idempotencyKey: createPrepared.operation.id,
    correlationId: createCorrelationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: createPrepared.operation.id,
      reason: "Restore missing owned Pokemon after support incident",
      actorType: "ADMIN",
      actorId: principalId,
    },
  });
  if (
    !createReplay.ok ||
    !createReplay.value.replayed ||
    createReplay.value.pokemonInstanceId !== pokemonInstanceId
  ) {
    throw new Error("Pokemon create owner did not replay the durable creation claim");
  }
  const createConflict = await pokemonOwner.createPokemon({
    playerId,
    formId,
    level: 6,
    idempotencyKey: createPrepared.operation.id,
    correlationId: createCorrelationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: createPrepared.operation.id,
      reason: "Restore missing owned Pokemon after support incident",
      actorType: "ADMIN",
      actorId: principalId,
    },
  });
  if (createConflict.ok || createConflict.error.code !== "FINGERPRINT_MISMATCH") {
    throw new Error("Pokemon create owner accepted semantic idempotency drift");
  }

  const downCorrelationId = randomUUID();
  const downPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progress.correct",
    input: { playerId, pokemonInstanceId, level: 3, xp: 5 },
    reason: "Correct inflated Pokemon progression",
    expectedRevision: 0n,
    idempotencyKey: `pokemon-progress-down-${randomUUID()}`,
    correlationId: downCorrelationId,
  });
  if (downPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Pokemon progression correction must require confirmation");
  }
  await admin.confirm(downPrepared.operation.id, principalId);
  const downApplied = await admin.apply(downPrepared.operation.id, principalId);
  if (
    downApplied.status !== "APPLIED" ||
    downApplied.result?.operationKind !== "PROGRESSION_CORRECT" ||
    downApplied.result?.afterRevision !== "1"
  ) {
    throw new Error("Pokemon downward progression correction did not apply");
  }
  const downState = await pool.query<{
    level: number;
    xp: string;
    current_hp: number;
    revision: string;
    form_id: string;
    move_count: string;
    correction_count: string;
    xp_ledger_count: string;
  }>(
    `SELECT instance.level, instance.xp::text, instance.current_hp, instance.revision::text,
            instance.form_id,
            (SELECT count(*)::text FROM pokemon_move_slots WHERE pokemon_instance_id = instance.id) AS move_count,
            (SELECT count(*)::text FROM pokemon_admin_progress_corrections
             WHERE pokemon_instance_id = instance.id) AS correction_count,
            (SELECT count(*)::text FROM pokemon_xp_ledger
             WHERE pokemon_instance_id = instance.id) AS xp_ledger_count
     FROM pokemon_instances instance WHERE instance.id = $1`,
    [pokemonInstanceId],
  );
  const downRow = downState.rows[0];
  if (
    downRow?.level !== 3 ||
    downRow.xp !== "5" ||
    downRow.current_hp <= 0 ||
    downRow.current_hp >= createdHp ||
    downRow.revision !== "1" ||
    downRow.form_id !== formId ||
    downRow.move_count !== "1" ||
    downRow.correction_count !== "1" ||
    downRow.xp_ledger_count !== "0"
  ) {
    throw new Error("Pokemon downward correction violated progression invariants");
  }

  const downReplay = await pokemonOwner.correctProgress({
    playerId,
    pokemonInstanceId,
    level: 3,
    xp: 5,
    expectedRevision: 0n,
    idempotencyKey: downPrepared.operation.id,
    correlationId: downCorrelationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: downPrepared.operation.id,
      reason: "Correct inflated Pokemon progression",
      actorType: "ADMIN",
      actorId: principalId,
    },
  });
  if (!downReplay.ok || !downReplay.value.replayed) {
    throw new Error("Pokemon progression owner did not replay the durable correction");
  }

  const invalidXp = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progress.correct",
    input: { playerId, pokemonInstanceId, level: 3, xp: 37 },
    reason: "Reject invalid XP threshold proof",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-progress-invalid-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(invalidXp.operation.id, principalId);
  await expectRejected(
    admin.apply(invalidXp.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  const upPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progress.correct",
    input: { playerId, pokemonInstanceId, level: 6, xp: 0 },
    reason: "Correct missing Pokemon levels without replaying history",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-progress-up-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(upPrepared.operation.id, principalId);
  const upApplied = await admin.apply(upPrepared.operation.id, principalId);
  if (upApplied.result?.afterRevision !== "2") {
    throw new Error("Pokemon upward correction did not advance aggregate revision");
  }
  const upState = await pool.query<{
    level: number;
    xp: string;
    revision: string;
    form_id: string;
    move_count: string;
    evolution_claim_count: string;
    correction_count: string;
  }>(
    `SELECT instance.level, instance.xp::text, instance.revision::text, instance.form_id,
            (SELECT count(*)::text FROM pokemon_move_slots WHERE pokemon_instance_id = instance.id) AS move_count,
            (SELECT count(*)::text FROM pokemon_evolution_claims
             WHERE pokemon_instance_id = instance.id) AS evolution_claim_count,
            (SELECT count(*)::text FROM pokemon_admin_progress_corrections
             WHERE pokemon_instance_id = instance.id) AS correction_count
     FROM pokemon_instances instance WHERE instance.id = $1`,
    [pokemonInstanceId],
  );
  const upRow = upState.rows[0];
  if (
    upRow?.level !== 6 ||
    upRow.xp !== "0" ||
    upRow.revision !== "2" ||
    upRow.form_id !== formId ||
    upRow.move_count !== "1" ||
    upRow.evolution_claim_count !== "0" ||
    upRow.correction_count !== "2"
  ) {
    throw new Error("Admin progression correction replayed irreversible historical side effects");
  }

  const stale = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progress.correct",
    input: { playerId, pokemonInstanceId, level: 4, xp: 0 },
    reason: "Stale lifecycle revision proof",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-progress-stale-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(stale.operation.id, principalId);
  await expectRejected(
    admin.apply(stale.operation.id, principalId),
    ADMIN_ERROR_CODES.REVISION_CONFLICT,
  );

  for (const [table, key] of [
    ["pokemon_admin_create_claims", createPrepared.operation.id],
    ["pokemon_admin_progress_corrections", downPrepared.operation.id],
  ] as const) {
    await pool
      .query(`UPDATE ${table} SET result = '{}'::jsonb WHERE idempotency_key = $1`, [key])
      .then(
        () => {
          throw new Error(`${table} must be append-only`);
        },
        () => undefined,
      );
  }

  console.log(
    "Phase 12 Pokemon lifecycle admin proof complete: deterministic create, durable replay, target progression correction, HP/CAS, no XP-ledger forgery, no retroactive moves/evolution and append-only evidence verified",
  );
} finally {
  await pool.end();
}
