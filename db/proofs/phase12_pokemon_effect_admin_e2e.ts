import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { PokemonAdminService } from "../../src/modules/pokemon/admin-service.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresPokemonAdminRepository } from "../../src/platform/pokemon/postgres-pokemon-admin-repository.js";
import { PostgresPokemonEffectAdminRepository } from "../../src/platform/pokemon/postgres-pokemon-effect-admin-repository.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

async function expectRejected(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Expected ${code}`);
    },
    (error: unknown) => {
      if (!(error instanceof AdminError) || error.code !== code) throw error;
    },
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 6 });
try {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const persistentEffectId = randomUUID();
  const instantEffectId = randomUUID();
  const playerId = randomUUID();
  const pokemonId = randomUUID();
  const principalId = randomUUID();

  const rules = {
    version: 1,
    steps: [{ effectKey: "prevent-accuracy-drop", config: {} }],
  } as const;
  const rulesetConfig = {
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
  } as const;

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, $3::jsonb, 'DRAFT')`,
    [rulesetId, `phase12-effect-rules-${rulesetId}`, JSON.stringify(rulesetConfig)],
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

  const releaseNoResult = await pool.query<{ release_no: string }>(
    `SELECT (COALESCE(MAX(release_no), 910000) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = releaseNoResult.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate effect proof release");
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 12 Pokemon Effect Proof', 'DRAFT', $3)`,
    [releaseId, releaseNo, rulesetId],
  );

  await pool.query(`INSERT INTO pokemon_types(id, slug) VALUES ($1, $2)`, [
    typeId,
    `phase12-effect-type-${typeId}`,
  ]);
  await pool.query(`INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 32001, $2)`, [
    speciesId,
    `phase12-effect-species-${speciesId}`,
  ]);
  await pool.query(`INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')`, [
    formId,
    speciesId,
  ]);
  await pool.query(
    `INSERT INTO pokemon_type_revisions(id, content_release_id, type_id, display_name)
     VALUES ($1, $2, $3, 'Effect Proof Type')`,
    [randomUUID(), releaseId, typeId],
  );
  await pool.query(
    `INSERT INTO pokemon_species_revisions(id, content_release_id, species_id, display_name)
     VALUES ($1, $2, $3, 'Effectproofmon')`,
    [randomUUID(), releaseId, speciesId],
  );
  await pool.query(
    `INSERT INTO pokemon_form_revisions(
       id, content_release_id, form_id, display_name, type1_id,
       base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     ) VALUES ($1, $2, $3, 'Effectproofmon', $4, 45, 45, 45, 45, 45, 45)`,
    [randomUUID(), releaseId, formId, typeId],
  );
  await pool.query(`INSERT INTO effects(id, slug) VALUES ($1, $2), ($3, $4)`, [
    persistentEffectId,
    `phase12-persistent-${persistentEffectId}`,
    instantEffectId,
    `phase12-instant-${instantEffectId}`,
  ]);
  await pool.query(
    `INSERT INTO effect_revisions(
       id, content_release_id, effect_id, scope, stacking_policy, duration_model, rules
     ) VALUES
       ($1, $2, $3, 'POKEMON', 'REFRESH', 'PERSISTENT', $4::jsonb),
       ($5, $2, $6, 'POKEMON', 'REFRESH', 'INSTANT', $4::jsonb)`,
    [randomUUID(), releaseId, persistentEffectId, JSON.stringify(rules), randomUUID(), instantEffectId],
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
  await pool.query(
    `INSERT INTO pokemon_instances(
       id, owner_player_id, form_id, level, current_hp, origin_type, origin_id
     ) VALUES ($1, $2, $3, 5, 19, 'ADMIN_PROOF', $4)`,
    [pokemonId, playerId, formId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO pokemon_training_values(
       pokemon_instance_id, iv_hp, iv_attack, iv_defense, iv_sp_attack, iv_sp_defense, iv_speed
     ) VALUES ($1, 0, 0, 0, 0, 0, 0)`,
    [pokemonId],
  );

  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'POKEMON_ADMIN'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error("POKEMON_ADMIN role is missing");
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')`,
    [principalId, `phase12:pokemon-effect:${principalId}`],
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
  const pokemon = new PokemonAdminService(
    new PostgresPokemonAdminRepository(pool),
    new PostgresPokemonEffectAdminRepository(pool),
  );
  const domain = new AdminDomainOperationService(
    new EconomyService(new PostgresEconomyRepository(pool)),
    new ProgressionService(new PostgresProgressionRepository(pool)),
    new PostgresAdminOperationCompletion(pool),
    pokemon,
  );
  const registry = registerPhase12CDomainAdminOperations(
    createPhase12AdminOperationRegistry(adminRepository),
    domain,
  );
  const admin = new AdminService(registry, adminRepository);

  const applyPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.effect.apply",
    input: { playerId, pokemonInstanceId: pokemonId, effectId: persistentEffectId },
    reason: "Apply persistent support effect",
    expectedRevision: 0n,
    idempotencyKey: `effect-apply-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (applyPrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("Pokemon effect apply must require confirmation");
  }
  await admin.confirm(applyPrepared.operation.id, principalId);
  const applied = await admin.apply(applyPrepared.operation.id, principalId);
  if (applied.result?.operationKind !== "EFFECT_APPLY" || applied.result?.afterRevision !== "1") {
    throw new Error("Persistent effect apply did not complete through Pokemon owner");
  }

  const first = await pool.query<{
    id: string;
    config: unknown;
    content_release_id: string;
    revision: string;
    pokemon_revision: string;
  }>(
    `SELECT effect.id, effect.config, effect.content_release_id, effect.revision::text,
            pokemon.revision::text AS pokemon_revision
     FROM active_effects effect
     JOIN pokemon_instances pokemon ON pokemon.id = effect.pokemon_instance_id
     WHERE effect.pokemon_instance_id = $1 AND effect.effect_id = $2`,
    [pokemonId, persistentEffectId],
  );
  const firstRow = first.rows[0];
  if (
    first.rows.length !== 1 ||
    firstRow?.content_release_id !== releaseId ||
    firstRow.pokemon_revision !== "1" ||
    JSON.stringify(firstRow.config) !== JSON.stringify(rules)
  ) {
    throw new Error("Persistent effect apply did not pin active release rules exactly");
  }
  const activeEffectId = firstRow.id;

  const refreshPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.effect.apply",
    input: { playerId, pokemonInstanceId: pokemonId, effectId: persistentEffectId },
    reason: "Refresh persistent support effect",
    expectedRevision: 1n,
    idempotencyKey: `effect-refresh-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(refreshPrepared.operation.id, principalId);
  await admin.apply(refreshPrepared.operation.id, principalId);
  const refreshed = await pool.query<{
    id: string;
    effect_revision: string;
    pokemon_revision: string;
    count: string;
  }>(
    `SELECT effect.id, effect.revision::text AS effect_revision,
            pokemon.revision::text AS pokemon_revision,
            (SELECT count(*)::text FROM active_effects
             WHERE pokemon_instance_id = $1 AND effect_id = $2) AS count
     FROM active_effects effect
     JOIN pokemon_instances pokemon ON pokemon.id = effect.pokemon_instance_id
     WHERE effect.id = $3`,
    [pokemonId, persistentEffectId, activeEffectId],
  );
  const refreshedRow = refreshed.rows[0];
  if (
    refreshedRow?.id !== activeEffectId ||
    refreshedRow.effect_revision !== "1" ||
    refreshedRow.pokemon_revision !== "2" ||
    refreshedRow.count !== "1"
  ) {
    throw new Error("REFRESH stacking created duplicate or failed aggregate revision");
  }

  const instantPrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.effect.apply",
    input: { playerId, pokemonInstanceId: pokemonId, effectId: instantEffectId },
    reason: "Instant effects must not become active rows",
    expectedRevision: 2n,
    idempotencyKey: `effect-instant-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(instantPrepared.operation.id, principalId);
  await expectRejected(
    admin.apply(instantPrepared.operation.id, principalId),
    ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
  );
  const afterInstant = await pool.query<{ revision: string; instant_count: string }>(
    `SELECT pokemon.revision::text AS revision,
            (SELECT count(*)::text FROM active_effects
             WHERE pokemon_instance_id = $1 AND effect_id = $2) AS instant_count
     FROM pokemon_instances pokemon WHERE pokemon.id = $1`,
    [pokemonId, instantEffectId],
  );
  if (afterInstant.rows[0]?.revision !== "2" || afterInstant.rows[0]?.instant_count !== "0") {
    throw new Error("Rejected INSTANT effect left partial state");
  }

  const removePrepared = await admin.prepareMutation({
    principalId,
    operationType: "pokemon.effect.remove",
    input: { playerId, pokemonInstanceId: pokemonId, activeEffectId },
    reason: "Remove persistent support effect",
    expectedRevision: 2n,
    idempotencyKey: `effect-remove-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(removePrepared.operation.id, principalId);
  const removed = await admin.apply(removePrepared.operation.id, principalId);
  if (removed.result?.operationKind !== "EFFECT_REMOVE" || removed.result?.afterRevision !== "3") {
    throw new Error("Persistent effect remove did not complete through Pokemon owner");
  }
  const finalState = await pool.query<{ effect_count: string; revision: string; history_count: string }>(
    `SELECT
       (SELECT count(*)::text FROM active_effects WHERE id = $2) AS effect_count,
       pokemon.revision::text AS revision,
       (SELECT count(*)::text FROM pokemon_history_events
        WHERE pokemon_instance_id = $1
          AND event_type IN ('ADMIN_EFFECT_APPLIED','ADMIN_EFFECT_REMOVED')) AS history_count
     FROM pokemon_instances pokemon WHERE pokemon.id = $1`,
    [pokemonId, activeEffectId],
  );
  if (
    finalState.rows[0]?.effect_count !== "0" ||
    finalState.rows[0]?.revision !== "3" ||
    finalState.rows[0]?.history_count !== "3"
  ) {
    throw new Error("Effect lifecycle audit or aggregate state is incomplete");
  }

  console.log(
    "Phase 12 Pokemon Effect Admin E2E passed: persistent apply/refresh/remove are versioned, CAS-safe and audited",
  );
} finally {
  await pool.end();
}
