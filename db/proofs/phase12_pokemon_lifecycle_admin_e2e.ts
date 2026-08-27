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
  const abilityId = randomUUID();
  const moveId = randomUUID();
  const invalidMoveId = randomUUID();
  const playerId = randomUUID();
  const otherPlayerId = randomUUID();
  const principalId = randomUUID();

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
    [rulesetId, `phase12-lifecycle-${rulesetId}`, JSON.stringify(rulesConfig)],
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
  await pool.query(`INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')`, [
    formId,
    speciesId,
  ]);
  await pool.query(`INSERT INTO abilities(id, slug) VALUES ($1, $2)`, [
    abilityId,
    `phase12-lifecycle-ability-${abilityId}`,
  ]);
  await pool.query(`INSERT INTO moves(id, slug) VALUES ($1, $2), ($3, $4)`, [
    moveId,
    `phase12-lifecycle-move-${moveId}`,
    invalidMoveId,
    `phase12-lifecycle-invalid-${invalidMoveId}`,
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
     ) VALUES ($1, $2, $3, 'Lifecyclemon', $4, 45, 49, 49, 65, 65, 45)`,
    [randomUUID(), releaseId, formId, typeId],
  );
  await pool.query(
    `INSERT INTO ability_revisions(
       id, content_release_id, ability_id, display_name, effect_config
     ) VALUES ($1, $2, $3, 'Proof Ability', '{}'::jsonb)`,
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
       category, power, accuracy, priority, max_pp, effect_config
     ) VALUES
       ($1, $2, $3, 'Proof Move', $4, 'PHYSICAL', 40, 100, 0, 35, '{}'::jsonb),
       ($5, $2, $6, 'Invalid Proof Move', $4, 'PHYSICAL', 40, 100, 0, 35, '{}'::jsonb)`,
    [randomUUID(), releaseId, moveId, typeId, randomUUID(), invalidMoveId],
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
  await pool.query(
    `INSERT INTO onboarding_states(player_id, state, completed_at)
     VALUES ($1, 'COMPLETE', now()), ($2, 'COMPLETE', now())`,
    [playerId, otherPlayerId],
  );

  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'POKEMON_ADMIN'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error("POKEMON_ADMIN role must be seeded before lifecycle proof");
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')`,
    [principalId, `phase12:lifecycle:${principalId}`],
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
  const lifecycleRepository = new PostgresPokemonLifecycleAdminRepository(pool);
  const pokemonOwner = new PokemonAdminService(
    new PostgresPokemonAdminRepository(pool),
    undefined,
    lifecycleRepository,
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

  const createPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.create",
    input: {
      playerId,
      formId,
      level: 5,
      xp: 0,
      abilityId,
      natureId: null,
      ivs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
      moveIds: [moveId],
      nickname: "Proof",
      shiny: true,
    },
    reason: "Restore a valid Pokemon lost during support incident",
    idempotencyKey: `pokemon-create-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (createPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("R3 Pokemon creation must require confirmation");
  }
  await expectRejected(
    admin.apply(createPrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  await admin.confirm(createPrepared.operation.id, principalId);
  const createApplied = await admin.apply(createPrepared.operation.id, principalId);
  if (createApplied.status !== "APPLIED" || createApplied.result?.operationKind !== "CREATE") {
    throw new Error("Pokemon creation did not complete through the owner");
  }

  const createdClaim = await pool.query<{ pokemon_instance_id: string }>(
    `SELECT pokemon_instance_id FROM pokemon_admin_operation_claims WHERE idempotency_key = $1`,
    [createPrepared.operation.id],
  );
  const pokemonInstanceId = createdClaim.rows[0]?.pokemon_instance_id;
  if (pokemonInstanceId === undefined) throw new Error("Pokemon create claim did not persist instance id");

  const createdState = await pool.query<{
    status: string;
    level: number;
    xp: string;
    current_hp: number;
    shiny: boolean;
    ability_id: string | null;
    revision: string;
    placement_kind: string;
    slot_no: number;
    move_count: string;
    pokedex_seen: string;
    pokedex_caught: string;
    history_count: string;
  }>(
    `SELECT pokemon.status, pokemon.level, pokemon.xp::text, pokemon.current_hp,
            pokemon.shiny, pokemon.ability_id, pokemon.revision::text,
            roster.placement_kind, roster.slot_no,
            (SELECT count(*)::text FROM pokemon_move_slots WHERE pokemon_instance_id = pokemon.id) AS move_count,
            pokedex.seen_count::text AS pokedex_seen,
            pokedex.caught_count::text AS pokedex_caught,
            (SELECT count(*)::text FROM pokemon_history_events
             WHERE pokemon_instance_id = pokemon.id AND event_type = 'ADMIN_CREATED') AS history_count
     FROM pokemon_instances pokemon
     JOIN pokemon_roster_slots roster ON roster.pokemon_instance_id = pokemon.id
     JOIN pokemon_forms form ON form.id = pokemon.form_id
     JOIN player_pokedex_species pokedex
       ON pokedex.player_id = pokemon.owner_player_id AND pokedex.species_id = form.species_id
     WHERE pokemon.id = $1 AND pokemon.owner_player_id = $2`,
    [pokemonInstanceId, playerId],
  );
  const created = createdState.rows[0];
  if (
    created?.status !== "ACTIVE" ||
    created.level !== 5 ||
    created.xp !== "0" ||
    created.current_hp !== 19 ||
    !created.shiny ||
    created.ability_id !== abilityId ||
    created.revision !== "0" ||
    created.placement_kind !== "TEAM" ||
    created.slot_no !== 1 ||
    created.move_count !== "1" ||
    created.pokedex_seen !== "1" ||
    created.pokedex_caught !== "1" ||
    created.history_count !== "1"
  ) {
    throw new Error("Pokemon create owner left incoherent state");
  }

  const createReplay = await admin.apply(createPrepared.operation.id, principalId);
  if (createReplay.id !== createApplied.id) throw new Error("Applied Pokemon create did not replay");
  const createCount = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pokemon_instances
     WHERE owner_player_id = $1 AND origin_type = 'ADMIN_OPERATION' AND origin_id = $2`,
    [playerId, createPrepared.operation.id],
  );
  if (createCount.rows[0]?.count !== "1") throw new Error("Pokemon create replay duplicated instance");

  await expectRejected(
    admin.prepareMutation({
      principalId,
      operationType: "pokemon.create",
      input: {
        playerId: otherPlayerId,
        formId,
        level: 5,
        xp: 0,
        abilityId,
        natureId: null,
        ivs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
        moveIds: [moveId],
        nickname: null,
        shiny: false,
      },
      reason: "BOLA scope proof",
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
      xp: 0,
      abilityId,
      natureId: null,
      ivs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
      moveIds: [invalidMoveId],
      nickname: null,
      shiny: false,
    },
    reason: "Reject illegal create build",
    idempotencyKey: `pokemon-create-invalid-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(invalidCreate.operation.id, principalId);
  await expectRejected(
    admin.apply(invalidCreate.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  const pokedexBefore = await pool.query<{ seen: string; caught: string }>(
    `SELECT seen_count::text AS seen, caught_count::text AS caught
     FROM player_pokedex_species WHERE player_id = $1 AND species_id = $2`,
    [playerId, speciesId],
  );
  const progressionPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progression.correct",
    input: { playerId, pokemonInstanceId, targetLevel: 6, targetXp: 0 },
    reason: "Correct Pokemon level after persisted support defect",
    expectedRevision: 0n,
    idempotencyKey: `pokemon-progression-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (progressionPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Pokemon progression correction must require confirmation");
  }
  await admin.confirm(progressionPrepared.operation.id, principalId);
  const progressionApplied = await admin.apply(progressionPrepared.operation.id, principalId);
  if (
    progressionApplied.status !== "APPLIED" ||
    progressionApplied.result?.operationKind !== "PROGRESSION_CORRECT" ||
    progressionApplied.result?.afterRevision !== "1"
  ) {
    throw new Error("Pokemon progression correction did not complete through owner");
  }

  const progressionState = await pool.query<{
    level: number;
    xp: string;
    current_hp: number;
    revision: string;
    move_count: string;
    form_id: string;
    xp_ledger_count: string;
    history_count: string;
  }>(
    `SELECT pokemon.level, pokemon.xp::text, pokemon.current_hp, pokemon.revision::text,
            pokemon.form_id,
            (SELECT count(*)::text FROM pokemon_move_slots WHERE pokemon_instance_id = pokemon.id) AS move_count,
            (SELECT count(*)::text FROM pokemon_xp_ledger WHERE pokemon_instance_id = pokemon.id) AS xp_ledger_count,
            (SELECT count(*)::text FROM pokemon_history_events
             WHERE pokemon_instance_id = pokemon.id AND event_type = 'ADMIN_PROGRESSION_CORRECTED') AS history_count
     FROM pokemon_instances pokemon WHERE pokemon.id = $1`,
    [pokemonInstanceId],
  );
  const progressed = progressionState.rows[0];
  if (
    progressed?.level !== 6 ||
    progressed.xp !== "0" ||
    progressed.current_hp !== 21 ||
    progressed.revision !== "1" ||
    progressed.move_count !== "1" ||
    progressed.form_id !== formId ||
    progressed.xp_ledger_count !== "0" ||
    progressed.history_count !== "1"
  ) {
    throw new Error("Pokemon progression correction violated state preservation");
  }
  const pokedexAfter = await pool.query<{ seen: string; caught: string }>(
    `SELECT seen_count::text AS seen, caught_count::text AS caught
     FROM player_pokedex_species WHERE player_id = $1 AND species_id = $2`,
    [playerId, speciesId],
  );
  if (
    pokedexAfter.rows[0]?.seen !== pokedexBefore.rows[0]?.seen ||
    pokedexAfter.rows[0]?.caught !== pokedexBefore.rows[0]?.caught
  ) {
    throw new Error("Pokemon progression correction inflated Pokedex counts");
  }

  const xpPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progression.correct",
    input: { playerId, pokemonInstanceId, targetLevel: 6, targetXp: 10 },
    reason: "Correct exact in-level XP",
    expectedRevision: 1n,
    idempotencyKey: `pokemon-xp-correct-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(xpPrepared.operation.id, principalId);
  const xpApplied = await admin.apply(xpPrepared.operation.id, principalId);
  if (xpApplied.result?.afterRevision !== "2") throw new Error("XP correction did not advance CAS");

  const invalidXp = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progression.correct",
    input: { playerId, pokemonInstanceId, targetLevel: 6, targetXp: 127 },
    reason: "Reject XP at next-level threshold",
    expectedRevision: 2n,
    idempotencyKey: `pokemon-xp-invalid-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(invalidXp.operation.id, principalId);
  await expectRejected(
    admin.apply(invalidXp.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  await pool.query(
    `INSERT INTO pending_move_choices(
       id, pokemon_instance_id, content_release_id, move_id, learn_level,
       source_type, source_id, correlation_id
     ) VALUES ($1, $2, $3, $4, 6, 'ADMIN_PROOF', $5, $6)`,
    [randomUUID(), pokemonInstanceId, releaseId, moveId, randomUUID(), randomUUID()],
  );
  const lowerPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.progression.correct",
    input: { playerId, pokemonInstanceId, targetLevel: 5, targetXp: 0 },
    reason: "Reject level lowering across pending move choice",
    expectedRevision: 2n,
    idempotencyKey: `pokemon-level-lower-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(lowerPrepared.operation.id, principalId);
  await expectRejected(
    admin.apply(lowerPrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );

  const finalState = await pool.query<{ level: number; xp: string; revision: string }>(
    `SELECT level, xp::text, revision::text FROM pokemon_instances WHERE id = $1`,
    [pokemonInstanceId],
  );
  if (
    finalState.rows[0]?.level !== 6 ||
    finalState.rows[0]?.xp !== "10" ||
    finalState.rows[0]?.revision !== "2"
  ) {
    throw new Error("Rejected Pokemon progression correction left partial state");
  }

  console.log(
    "Phase 12 Pokemon Lifecycle Admin E2E passed: invariant create, scope, replay, exact level/XP correction, HP/stat preservation, move/Pokedex preservation and pending-choice fail-closed verified",
  );
} finally {
  await pool.end();
}
