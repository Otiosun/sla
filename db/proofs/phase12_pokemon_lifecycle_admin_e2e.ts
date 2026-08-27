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
  const natureId = randomUUID();
  const abilityId = randomUUID();
  const moveId = randomUUID();
  const playerId = randomUUID();
  const otherPlayerId = randomUUID();
  const principalId = randomUUID();

  const rules = RulesetConfigSchema.parse({
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
    [rulesetId, `phase12-lifecycle-${rulesetId}`, JSON.stringify(rules)],
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
    `SELECT (COALESCE(MAX(release_no), 910000) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = nextRelease.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate lifecycle proof release number");
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 12 Pokemon Lifecycle Admin Proof', 'DRAFT', $3)`,
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
  await pool.query(`INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')`, [
    formId,
    speciesId,
  ]);
  await pool.query(`INSERT INTO natures(id, slug) VALUES ($1, $2)`, [
    natureId,
    `phase12-lifecycle-nature-${natureId}`,
  ]);
  await pool.query(`INSERT INTO abilities(id, slug) VALUES ($1, $2)`, [
    abilityId,
    `phase12-lifecycle-ability-${abilityId}`,
  ]);
  await pool.query(`INSERT INTO moves(id, slug) VALUES ($1, $2)`, [
    moveId,
    `phase12-lifecycle-move-${moveId}`,
  ]);
  await pool.query(
    `INSERT INTO pokemon_type_revisions(id, content_release_id, type_id, display_name)
     VALUES ($1, $2, $3, 'Lifecycle Type')`,
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
     ) VALUES ($1, $2, $3, 'Lifecyclemon', $4, 45, 49, 49, 65, 65, 45)`,
    [randomUUID(), releaseId, formId, typeId],
  );
  await pool.query(
    `INSERT INTO nature_revisions(
       id, content_release_id, nature_id, display_name, increased_stat, decreased_stat
     ) VALUES ($1, $2, $3, 'Lifecycle Nature', NULL, NULL)`,
    [randomUUID(), releaseId, natureId],
  );
  await pool.query(
    `INSERT INTO ability_revisions(
       id, content_release_id, ability_id, display_name, effect_key, effect_config
     ) VALUES ($1, $2, $3, 'Lifecycle Ability', NULL, '{}'::jsonb)`,
    [randomUUID(), releaseId, abilityId],
  );
  await pool.query(
    `INSERT INTO pokemon_form_ability_options(
       id, content_release_id, form_id, ability_id, slot_kind
     ) VALUES ($1, $2, $3, $4, 'PRIMARY')`,
    [randomUUID(), releaseId, formId, abilityId],
  );
  await pool.query(
    `INSERT INTO move_revisions(
       id, content_release_id, move_id, display_name, type_id,
       category, power, accuracy, priority, max_pp, effect_key, effect_config
     ) VALUES ($1, $2, $3, 'Lifecycle Move', $4,
               'PHYSICAL', 40, 100, 0, 35, NULL, '{}'::jsonb)`,
    [randomUUID(), releaseId, moveId, typeId],
  );
  await pool.query(
    `INSERT INTO move_learnset_entries(
       id, content_release_id, form_id, move_id, learn_method, learn_level
     ) VALUES ($1, $2, $3, $4, 'START', NULL)`,
    [randomUUID(), releaseId, formId, moveId],
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

  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`, [
    playerId,
    otherPlayerId,
  ]);
  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'POKEMON_ADMIN'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error("POKEMON_ADMIN role must be seeded before proof");
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')`,
    [principalId, `phase12:lifecycle-admin:${principalId}`],
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

  const ivs = { hp: 12, attack: 13, defense: 14, spAttack: 15, spDefense: 16, speed: 17 };
  const createCorrelationId = randomUUID();
  const createPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.create",
    input: { playerId, formId, level: 5, natureId, abilityId, ivs, moveIds: [moveId] },
    reason: "Grant replacement Pokemon after support incident",
    idempotencyKey: `pokemon-create-${randomUUID()}`,
    correlationId: createCorrelationId,
  });
  if (createPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("R3 Pokemon create must require confirmation");
  }
  await expectRejected(
    admin.apply(createPrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  await admin.confirm(createPrepared.operation.id, principalId);
  const created = await admin.apply(createPrepared.operation.id, principalId);
  const createdPokemonId = created.resourceId;
  if (
    created.status !== "APPLIED" ||
    createdPokemonId === null ||
    created.result?.operationKind !== "CREATE" ||
    created.result?.beforeRevision !== null ||
    created.result?.afterRevision !== "0"
  ) {
    throw new Error("Pokemon create did not complete through the lifecycle owner");
  }
  const createdState = await pool.query<{
    level: number;
    xp: string;
    current_hp: number;
    revision: string;
    placement_kind: string;
    slot_no: number;
    pp_current: number | null;
    caught_count: string;
    claim_count: string;
    history_count: string;
  }>(
    `SELECT pokemon.level, pokemon.xp::text, pokemon.current_hp, pokemon.revision::text,
            roster.placement_kind, roster.slot_no, moves.pp_current,
            pokedex.caught_count::text,
            (SELECT count(*)::text FROM pokemon_admin_operation_claims
             WHERE idempotency_key = $3) AS claim_count,
            (SELECT count(*)::text FROM pokemon_history_events
             WHERE pokemon_instance_id = $1 AND event_type = 'ADMIN_CREATED') AS history_count
     FROM pokemon_instances pokemon
     JOIN pokemon_roster_slots roster ON roster.pokemon_instance_id = pokemon.id
     JOIN pokemon_move_slots moves ON moves.pokemon_instance_id = pokemon.id AND moves.slot_no = 1
     JOIN player_pokedex_species pokedex
       ON pokedex.player_id = pokemon.owner_player_id AND pokedex.species_id = $4
     WHERE pokemon.id = $1 AND pokemon.owner_player_id = $2`,
    [createdPokemonId, playerId, createPrepared.operation.id, speciesId],
  );
  const createRow = createdState.rows[0];
  if (
    createRow?.level !== 5 ||
    createRow.xp !== "0" ||
    createRow.current_hp <= 0 ||
    createRow.revision !== "0" ||
    createRow.placement_kind !== "TEAM" ||
    createRow.slot_no !== 1 ||
    createRow.pp_current !== 35 ||
    BigInt(createRow.caught_count) < 1n ||
    createRow.claim_count !== "1" ||
    createRow.history_count !== "1"
  ) {
    throw new Error("Created Pokemon bundle is not mechanically coherent");
  }

  const ownerCreateReplay = await pokemonOwner.createPokemon({
    playerId,
    formId,
    level: 5,
    natureId,
    abilityId,
    ivs,
    moveIds: [moveId],
    idempotencyKey: createPrepared.operation.id,
    correlationId: createCorrelationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: createPrepared.operation.id,
      reason: "Grant replacement Pokemon after support incident",
      actorType: "ADMIN",
      actorId: principalId,
    },
  });
  if (
    !ownerCreateReplay.ok ||
    !ownerCreateReplay.value.replayed ||
    ownerCreateReplay.value.pokemonInstanceId !== createdPokemonId
  ) {
    throw new Error("Pokemon create owner did not replay the durable generated identity");
  }

  await expectRejected(
    admin.prepareMutation({
      principalId,
      operationType: "pokemon.create",
      input: { playerId: otherPlayerId, formId, level: 5, natureId, abilityId, ivs, moveIds: [moveId] },
      reason: "BOLA create scope proof",
      idempotencyKey: `pokemon-create-bola-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  const invalidCreate = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.create",
    input: {
      playerId,
      formId,
      level: 5,
      natureId,
      abilityId: randomUUID(),
      ivs,
      moveIds: [moveId],
    },
    reason: "Reject invalid ability build",
    idempotencyKey: `pokemon-create-invalid-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(invalidCreate.operation.id, principalId);
  await expectRejected(
    admin.apply(invalidCreate.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );
  const pokemonCount = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pokemon_instances WHERE owner_player_id = $1`,
    [playerId],
  );
  if (pokemonCount.rows[0]?.count !== "1") {
    throw new Error("Rejected Pokemon create left a partial instance");
  }

  const progressUp = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progress.correct",
    input: { playerId, pokemonInstanceId: createdPokemonId, deltaXp: "1000" },
    reason: "Restore progression lost during incident",
    expectedRevision: 0n,
    idempotencyKey: `pokemon-progress-up-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (progressUp.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("R3 Pokemon progress correction must require confirmation");
  }
  await admin.confirm(progressUp.operation.id, principalId);
  const progressed = await admin.apply(progressUp.operation.id, principalId);
  if (progressed.result?.afterRevision !== "1") {
    throw new Error("Pokemon progress correction did not advance aggregate revision");
  }
  const progressState = await pool.query<{
    level: number;
    xp: string;
    revision: string;
    form_id: string;
    move_count: string;
    pending_count: string;
    evolution_count: string;
  }>(
    `SELECT pokemon.level, pokemon.xp::text, pokemon.revision::text, pokemon.form_id,
            (SELECT count(*)::text FROM pokemon_move_slots WHERE pokemon_instance_id = $1) AS move_count,
            (SELECT count(*)::text FROM pending_move_choices WHERE pokemon_instance_id = $1) AS pending_count,
            (SELECT count(*)::text FROM pokemon_evolution_claims WHERE pokemon_instance_id = $1) AS evolution_count
     FROM pokemon_instances pokemon WHERE pokemon.id = $1`,
    [createdPokemonId],
  );
  const upRow = progressState.rows[0];
  if (
    upRow?.level !== 10 ||
    upRow.xp !== "125" ||
    upRow.revision !== "1" ||
    upRow.form_id !== formId ||
    upRow.move_count !== "1" ||
    upRow.pending_count !== "0" ||
    upRow.evolution_count !== "0"
  ) {
    throw new Error("Positive admin progress correction violated preserve-form/moves policy");
  }

  const progressDown = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progress.correct",
    input: { playerId, pokemonInstanceId: createdPokemonId, deltaXp: "-1000" },
    reason: "Reverse erroneous progression correction",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-progress-down-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(progressDown.operation.id, principalId);
  const correctedDown = await admin.apply(progressDown.operation.id, principalId);
  if (correctedDown.result?.afterRevision !== "2") {
    throw new Error("Downward Pokemon progress correction did not advance revision");
  }
  const downState = await pool.query<{ level: number; xp: string; revision: string }>(
    `SELECT level, xp::text, revision::text FROM pokemon_instances WHERE id = $1`,
    [createdPokemonId],
  );
  if (
    downState.rows[0]?.level !== 5 ||
    downState.rows[0]?.xp !== "0" ||
    downState.rows[0]?.revision !== "2"
  ) {
    throw new Error("Downward Pokemon progress correction did not restore exact state");
  }

  const underflow = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progress.correct",
    input: { playerId, pokemonInstanceId: createdPokemonId, deltaXp: "-1000" },
    reason: "Progress underflow proof",
    expectedRevision: 2n,
    idempotencyKey: `pokemon-progress-underflow-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(underflow.operation.id, principalId);
  await expectRejected(
    admin.apply(underflow.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );
  const afterUnderflow = await pool.query<{ level: number; xp: string; revision: string }>(
    `SELECT level, xp::text, revision::text FROM pokemon_instances WHERE id = $1`,
    [createdPokemonId],
  );
  if (
    afterUnderflow.rows[0]?.level !== 5 ||
    afterUnderflow.rows[0]?.xp !== "0" ||
    afterUnderflow.rows[0]?.revision !== "2"
  ) {
    throw new Error("Rejected progress underflow left partial Pokemon state");
  }

  const stale = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progress.correct",
    input: { playerId, pokemonInstanceId: createdPokemonId, deltaXp: "1" },
    reason: "Stale progress CAS proof",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-progress-stale-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(stale.operation.id, principalId);
  await expectRejected(
    admin.apply(stale.operation.id, principalId),
    ADMIN_ERROR_CODES.REVISION_CONFLICT,
  );

  const progressHistory = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pokemon_history_events
     WHERE pokemon_instance_id = $1 AND event_type = 'ADMIN_PROGRESS_CORRECTED'`,
    [createdPokemonId],
  );
  if (progressHistory.rows[0]?.count !== "2") {
    throw new Error("Pokemon progress corrections are not reconstructible from history");
  }

  console.log(
    "Phase 12 Pokemon Lifecycle Admin E2E passed: create/replay/scope/build validation and signed progress correction preserve roster, Pokedex, stats, form, moves and CAS invariants",
  );
} finally {
  await pool.end();
}
