import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { Player360Service } from "../../src/modules/admin/player360-service.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresPlayer360Repository } from "../../src/platform/admin/postgres-player360-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

function expectAdminCode(error: unknown, code: string): void {
  if (!(error instanceof AdminError) || error.code !== code) {
    throw error instanceof Error ? error : new Error(`Expected ${code}`);
  }
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const supportRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SUPPORT'`,
  );
  const ownerRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'OWNER_SECURITY_ADMIN'`,
  );
  const supportRoleId = supportRole.rows[0]?.id;
  const ownerRoleId = ownerRole.rows[0]?.id;
  if (supportRoleId === undefined || ownerRoleId === undefined) {
    throw new Error("Phase 12 roles must be seeded before Player 360 proof");
  }

  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const moveId = randomUUID();
  const abilityId = randomUUID();
  const natureId = randomUUID();
  const itemId = randomUUID();
  const effectId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const currencyId = randomUUID();

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status, published_at)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'PUBLISHED', now())`,
    [rulesetId, `player360-proof-${rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(
       id, release_no, name, status, default_ruleset_id, published_at
     ) VALUES ($1, 900001, 'Player 360 proof', 'PUBLISHED', $2, now())`,
    [releaseId, rulesetId],
  );
  await pool.query(`INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9001, $2)`, [
    speciesId,
    `proof-species-${speciesId}`,
  ]);
  await pool.query(`INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')`, [
    formId,
    speciesId,
  ]);
  await pool.query(`INSERT INTO moves(id, slug) VALUES ($1, $2)`, [moveId, `proof-move-${moveId}`]);
  await pool.query(`INSERT INTO abilities(id, slug) VALUES ($1, $2)`, [
    abilityId,
    `proof-ability-${abilityId}`,
  ]);
  await pool.query(`INSERT INTO natures(id, slug) VALUES ($1, $2)`, [
    natureId,
    `proof-nature-${natureId}`,
  ]);
  await pool.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [itemId, `proof-item-${itemId}`]);
  await pool.query(`INSERT INTO effects(id, slug) VALUES ($1, $2)`, [
    effectId,
    `proof-effect-${effectId}`,
  ]);
  await pool.query(`INSERT INTO regions(id, slug) VALUES ($1, $2)`, [
    regionId,
    `proof-region-${regionId}`,
  ]);
  await pool.query(`INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)`, [
    areaId,
    regionId,
    `proof-area-${areaId}`,
  ]);
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'Proof Coins', FALSE)`,
    [currencyId, `proof-currency-${currencyId}`],
  );

  const targetPlayerId = randomUUID();
  const secondPlayerId = randomUUID();
  const thirdPlayerId = randomUUID();
  const playerRows = [
    [targetPlayerId, "Player360 Alpha", "proof:target", "2026-01-03T00:00:00.000Z"],
    [secondPlayerId, "Player360 Beta", "proof:second", "2026-01-02T00:00:00.000Z"],
    [thirdPlayerId, "Player360 Gamma", "proof:third", "2026-01-01T00:00:00.000Z"],
  ] as const;

  for (const [playerId, trainerName, externalId, createdAt] of playerRows) {
    await pool.query(
      `INSERT INTO players(id, status, created_at, updated_at)
       VALUES ($1, 'ACTIVE', $2::timestamptz, $2::timestamptz)`,
      [playerId, createdAt],
    );
    await pool.query(
      `INSERT INTO player_profiles(
         player_id, trainer_name, origin_region_id, locale, metadata
       ) VALUES ($1, $2, $3, 'pt-BR', $4::jsonb)`,
      [playerId, trainerName, regionId, JSON.stringify({ privateNote: `secret-${trainerName}` })],
    );
    await pool.query(
      `INSERT INTO trainer_progression(player_id, level, progression_points)
       VALUES ($1, 3, 200)`,
      [playerId],
    );
    await pool.query(
      `INSERT INTO player_identities(id, player_id, provider, external_id, status)
       VALUES ($1, $2, 'WHATSAPP', $3, 'ACTIVE')`,
      [randomUUID(), playerId, externalId],
    );
  }

  await pool.query(
    `INSERT INTO onboarding_states(player_id, state)
     VALUES ($1, 'PROFILE_CREATED')`,
    [targetPlayerId],
  );
  await pool.query(
    `INSERT INTO player_onboarding_context(player_id, content_release_id, ruleset_id)
     VALUES ($1, $2, $3)`,
    [targetPlayerId, releaseId, rulesetId],
  );
  await pool.query(
    `INSERT INTO trainer_unlocks(
       player_id, unlock_key, source_type, source_id, status
     ) VALUES ($1, 'TOURNAMENT_BRACKET', 'PROOF', 'player360', 'ACTIVE')`,
    [targetPlayerId],
  );
  await pool.query(`INSERT INTO player_locations(player_id, area_id) VALUES ($1, $2)`, [
    targetPlayerId,
    areaId,
  ]);
  await pool.query(
    `INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, 777)`,
    [targetPlayerId, currencyId],
  );
  await pool.query(
    `INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES ($1, $2, 4)`,
    [targetPlayerId, itemId],
  );

  const pokemonId = randomUUID();
  await pool.query(
    `INSERT INTO pokemon_instances(
       id, owner_player_id, form_id, nickname, level, xp, current_hp, gender, shiny,
       ability_id, origin_type, revision
     ) VALUES ($1, $2, $3, 'Proofmon', 5, 125, 20, 'M', TRUE, $4, 'PROOF', 0)`,
    [pokemonId, targetPlayerId, formId, abilityId],
  );
  await pool.query(
    `INSERT INTO pokemon_training_values(
       pokemon_instance_id, nature_id, iv_hp, iv_attack, iv_defense,
       iv_sp_attack, iv_sp_defense, iv_speed
     ) VALUES ($1, $2, 31, 30, 29, 28, 27, 26)`,
    [pokemonId, natureId],
  );
  await pool.query(
    `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
     VALUES ($1, 1, $2, 15)`,
    [pokemonId, moveId],
  );
  await pool.query(
    `INSERT INTO pokemon_roster_slots(
       pokemon_instance_id, player_id, placement_kind, box_no, slot_no
     ) VALUES ($1, $2, 'TEAM', NULL, 1)`,
    [pokemonId, targetPlayerId],
  );
  await pool.query(
    `INSERT INTO pokemon_persistent_conditions(
       pokemon_instance_id, condition_key, source_type, source_id
     ) VALUES ($1, 'POISONED', 'PROOF', 'condition')`,
    [pokemonId],
  );
  await pool.query(
    `INSERT INTO pokemon_evolution_condition_flags(
       pokemon_instance_id, condition_key, status, source_type, source_id, correlation_id
     ) VALUES ($1, 'FRIENDSHIP_READY', 'ACTIVE', 'PROOF', 'evolution', $2)`,
    [pokemonId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO player_pokedex_species(
       player_id, species_id, seen_count, caught_count,
       first_seen_at, last_seen_at, first_caught_at, last_caught_at
     ) VALUES ($1, $2, 2, 1, now(), now(), now(), now())`,
    [targetPlayerId, speciesId],
  );
  await pool.query(
    `INSERT INTO pokemon_history_events(
       id, pokemon_instance_id, event_type, payload, actor_type, correlation_id
     ) VALUES ($1, $2, 'PLAYER360_PROOF', '{}'::jsonb, 'SYSTEM', $3)`,
    [randomUUID(), pokemonId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO trainer_progress_ledger(
       id, player_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id
     ) VALUES ($1, $2, 100, 'PROOF', 'progress', 'Player360 history', 'SYSTEM',
               'PLAYER360_PROOF', $3, $4)`,
    [randomUUID(), targetPlayerId, randomUUID(), randomUUID()],
  );
  await pool.query(
    `INSERT INTO inventory_ledger(
       id, player_id, item_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id
     ) VALUES ($1, $2, $3, 4, 'PROOF', 'inventory', 'Player360 history', 'SYSTEM',
               'PLAYER360_PROOF', $4, $5)`,
    [randomUUID(), targetPlayerId, itemId, randomUUID(), randomUUID()],
  );
  await pool.query(
    `INSERT INTO wallet_ledger(
       id, player_id, currency_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id
     ) VALUES ($1, $2, $3, 777, 'PROOF', 'wallet', 'Player360 history', 'SYSTEM',
               'PLAYER360_PROOF', $4, $5)`,
    [randomUUID(), targetPlayerId, currencyId, randomUUID(), randomUUID()],
  );
  await pool.query(
    `INSERT INTO active_effects(
       id, effect_id, content_release_id, player_id, source_type, source_id, stacks
     ) VALUES ($1, $2, $3, $4, 'PROOF', 'player360', 1)`,
    [randomUUID(), effectId, releaseId, targetPlayerId],
  );

  const encounterId = randomUUID();
  await pool.query(
    `INSERT INTO encounters(
       id, player_id, area_id, status, content_release_id, ruleset_id,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
       creation_idempotency_key
     ) VALUES ($1, $2, $3, 'PRESENTED', $4, $5, $6, $7, $8, 1, 'player360-proof')`,
    [
      encounterId,
      targetPlayerId,
      areaId,
      releaseId,
      rulesetId,
      Buffer.alloc(32, 1),
      Buffer.alloc(12, 2),
      Buffer.alloc(16, 3),
    ],
  );
  const battleId = randomUUID();
  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id, encounter_id,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
     ) VALUES ($1, 'WILD', 'ACTIVE', $2, $3, $4, $5, $6, $7, 1)`,
    [
      battleId,
      releaseId,
      rulesetId,
      encounterId,
      Buffer.alloc(32, 4),
      Buffer.alloc(12, 5),
      Buffer.alloc(16, 6),
    ],
  );
  await pool.query(
    `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
     VALUES ($1, $2, 1, 'PLAYER', $3)`,
    [randomUUID(), battleId, targetPlayerId],
  );

  const globalSupportId = randomUUID();
  const scopedSupportId = randomUUID();
  const ownerId = randomUUID();
  for (const [id, identity] of [
    [globalSupportId, "player360:global-support"],
    [scopedSupportId, "player360:scoped-support"],
    [ownerId, "player360:owner"],
  ]) {
    await pool.query(
      `INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')`,
      [id, identity],
    );
  }
  for (const id of [globalSupportId, scopedSupportId]) {
    await pool.query(`INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`, [
      id,
      supportRoleId,
    ]);
  }
  await pool.query(`INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`, [
    ownerId,
    ownerRoleId,
  ]);
  for (const id of [globalSupportId, ownerId]) {
    await pool.query(
      `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
       VALUES ($1, $2, 'GLOBAL', NULL)`,
      [randomUUID(), id],
    );
  }
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'PLAYER', $3)`,
    [randomUUID(), scopedSupportId, targetPlayerId],
  );

  const adminRepository = new PostgresAdminRepository(pool);
  const adminService = new AdminService(
    createPhase12AdminOperationRegistry(adminRepository),
    adminRepository,
  );
  const service = new Player360Service(adminService, new PostgresPlayer360Repository(pool));

  const redacted = await service.get({
    principalId: scopedSupportId,
    playerId: targetPlayerId,
  });
  if (redacted.identities[0]?.externalId !== null || redacted.profile.metadata !== null) {
    throw new Error("Non-sensitive Player 360 read leaked sensitive identity/profile data");
  }
  if (
    redacted.wallets.length !== 1 ||
    redacted.inventory.length !== 1 ||
    redacted.pokemon.length !== 1 ||
    redacted.pokemon[0]?.moves.length !== 1 ||
    redacted.pokemon[0]?.persistentConditions.length !== 1 ||
    redacted.pokemon[0]?.evolutionConditionFlags.length !== 1 ||
    redacted.pokedex.speciesCaught !== 1 ||
    redacted.location?.areaId !== areaId ||
    redacted.activeEncounter?.id !== encounterId ||
    redacted.activeBattle?.id !== battleId ||
    redacted.effects.length !== 1 ||
    redacted.recentActivity.length < 4
  ) {
    throw new Error("Player 360 aggregate is missing one or more canonical sections");
  }
  if (redacted.unsupportedSections.join(",") !== "COOLDOWNS,PUNISHMENTS_FLAGS") {
    throw new Error("Unmodeled Player 360 sections were not explicitly reported");
  }

  try {
    await service.get({
      principalId: scopedSupportId,
      playerId: targetPlayerId,
      includeSensitive: true,
    });
    throw new Error("Scoped support unexpectedly read sensitive Player 360 fields");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.AUTHORIZATION_DENIED);
  }

  try {
    await service.search({ principalId: scopedSupportId, trainerNamePrefix: "Player360" });
    throw new Error("Player-scoped support unexpectedly enumerated the player collection");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.AUTHORIZATION_DENIED);
  }

  const firstPage = await service.search({
    principalId: globalSupportId,
    trainerNamePrefix: "Player360",
    limit: 2,
  });
  if (firstPage.items.length !== 2 || firstPage.nextCursor === null) {
    throw new Error("Player 360 first cursor page is invalid");
  }
  if (
    firstPage.items.some((item) => item.identities.some((identity) => identity.externalId !== null))
  ) {
    throw new Error("Player 360 search leaked external identities without sensitive capability");
  }
  const secondPage = await service.search({
    principalId: globalSupportId,
    trainerNamePrefix: "Player360",
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  if (secondPage.items.length !== 1 || secondPage.nextCursor !== null) {
    throw new Error("Player 360 second cursor page is invalid");
  }
  const allPageIds = [...firstPage.items, ...secondPage.items].map((item) => item.playerId);
  if (new Set(allPageIds).size !== 3 || allPageIds[0] !== targetPlayerId) {
    throw new Error("Player 360 cursor pagination repeated, skipped or reordered players");
  }

  try {
    await service.search({
      principalId: globalSupportId,
      identityProvider: "WHATSAPP",
      externalId: "proof:target",
      includeSensitive: true,
    });
    throw new Error("Support unexpectedly performed sensitive identity lookup");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.AUTHORIZATION_DENIED);
  }

  const sensitive = await service.get({
    principalId: ownerId,
    playerId: targetPlayerId,
    includeSensitive: true,
  });
  if (
    sensitive.identities[0]?.externalId !== "proof:target" ||
    sensitive.profile.metadata?.privateNote !== "secret-Player360 Alpha"
  ) {
    throw new Error("Sensitive Player 360 capability did not reveal authorized fields");
  }
  const identitySearch = await service.search({
    principalId: ownerId,
    identityProvider: "WHATSAPP",
    externalId: "proof:target",
    includeSensitive: true,
  });
  if (
    identitySearch.items.length !== 1 ||
    identitySearch.items[0]?.playerId !== targetPlayerId ||
    identitySearch.items[0]?.identities[0]?.externalId !== "proof:target"
  ) {
    throw new Error("Sensitive exact identity lookup returned the wrong Player 360 result");
  }

  try {
    await service.search({ principalId: globalSupportId, cursor: "tampered" });
    throw new Error("Malformed Player 360 cursor unexpectedly succeeded");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.INVALID_INPUT);
  }

  const indexes = await pool.query<{
    created: string | null;
    status: string | null;
    name: string | null;
  }>(
    `SELECT to_regclass('idx_players_created_id')::text AS created,
            to_regclass('idx_players_status_created_id')::text AS status,
            to_regclass('idx_player_profiles_trainer_name_lower_pattern')::text AS name`,
  );
  if (
    indexes.rows[0]?.created === null ||
    indexes.rows[0]?.status === null ||
    indexes.rows[0]?.name === null
  ) {
    throw new Error("Player 360 search indexes are missing");
  }

  const unchanged = await pool.query<{ player_revision: string; pokemon_revision: string }>(
    `SELECT player.revision::text AS player_revision,
            pokemon.revision::text AS pokemon_revision
     FROM players player
     JOIN pokemon_instances pokemon ON pokemon.owner_player_id = player.id
     WHERE player.id = $1 AND pokemon.id = $2`,
    [targetPlayerId, pokemonId],
  );
  if (unchanged.rows[0]?.player_revision !== "0" || unchanged.rows[0]?.pokemon_revision !== "0") {
    throw new Error("Player 360 read path mutated authoritative domain state");
  }

  console.log(
    "Phase 12B Player 360 proof complete: scoped read, sensitive redaction, aggregate projection, global search, stable cursor pagination, identity lookup and read-only state verified",
  );
} finally {
  await pool.end();
}
