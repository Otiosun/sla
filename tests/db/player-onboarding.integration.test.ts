import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { createCorrelationId, type PlayerId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

interface Fixture {
  readonly regionId: string;
  readonly formId: string;
  readonly releaseId: string;
  readonly speciesId: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function expectPgCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected PostgreSQL error code ${expectedCode}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Expected PostgreSQL error code ${expectedCode}`
    ) {
      throw error;
    }
    expect(error).toMatchObject({ code: expectedCode });
  }
}

async function seedFixture(client: PoolClient): Promise<Fixture> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const moveId = randomUUID();
  const abilityId = randomUUID();
  const natureId = randomUUID();
  const regionId = randomUUID();

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'phase5-test', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "a".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 1, 'phase5-test-release', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );

  await client.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, 'normal')", [typeId]);
  await client.query(
    "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 1, 'bulbasaur')",
    [speciesId],
  );
  await client.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
    formId,
    speciesId,
  ]);
  await client.query("INSERT INTO moves(id, slug) VALUES ($1, 'tackle')", [moveId]);
  await client.query("INSERT INTO abilities(id, slug) VALUES ($1, 'overgrow')", [abilityId]);
  await client.query("INSERT INTO natures(id, slug) VALUES ($1, 'hardy')", [natureId]);
  await client.query("INSERT INTO regions(id, slug) VALUES ($1, 'kanto')", [regionId]);

  await client.query(
    `INSERT INTO pokemon_species_revisions(
       id, content_release_id, species_id, display_name, catch_rate, base_exp
     ) VALUES ($1, $2, $3, 'Bulbasaur', 45, 64)`,
    [randomUUID(), releaseId, speciesId],
  );
  await client.query(
    `INSERT INTO pokemon_form_revisions(
       id, content_release_id, form_id, display_name, type1_id,
       base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     ) VALUES ($1, $2, $3, 'Bulbasaur', $4, 45, 49, 49, 65, 65, 45)`,
    [randomUUID(), releaseId, formId, typeId],
  );
  await client.query(
    `INSERT INTO move_revisions(
       id, content_release_id, move_id, display_name, type_id, category,
       power, accuracy, priority, max_pp
     ) VALUES ($1, $2, $3, 'Tackle', $4, 'PHYSICAL', 40, 100, 0, 35)`,
    [randomUUID(), releaseId, moveId, typeId],
  );
  await client.query(
    `INSERT INTO ability_revisions(id, content_release_id, ability_id, display_name)
     VALUES ($1, $2, $3, 'Overgrow')`,
    [randomUUID(), releaseId, abilityId],
  );
  await client.query(
    `INSERT INTO nature_revisions(id, content_release_id, nature_id, display_name)
     VALUES ($1, $2, $3, 'Hardy')`,
    [randomUUID(), releaseId, natureId],
  );
  await client.query(
    `INSERT INTO region_revisions(id, content_release_id, region_id, display_name)
     VALUES ($1, $2, $3, 'Kanto')`,
    [randomUUID(), releaseId, regionId],
  );
  await client.query(
    `INSERT INTO pokemon_form_ability_options(
       id, content_release_id, form_id, ability_id, slot_kind
     ) VALUES ($1, $2, $3, $4, 'PRIMARY')`,
    [randomUUID(), releaseId, formId, abilityId],
  );
  await client.query(
    `INSERT INTO move_learnset_entries(
       id, content_release_id, form_id, move_id, learn_method
     ) VALUES ($1, $2, $3, $4, 'START')`,
    [randomUUID(), releaseId, formId, moveId],
  );
  await client.query(
    `INSERT INTO starter_options(
       id, content_release_id, region_id, form_id, starter_level, sort_order
     ) VALUES ($1, $2, $3, $4, 5, 1)`,
    [randomUUID(), releaseId, regionId, formId],
  );

  await client.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "b".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
  await client.query(
    "INSERT INTO content_release_pointers(pointer_key, content_release_id) VALUES ('ACTIVE', $1)",
    [releaseId],
  );

  return { regionId, formId, releaseId, speciesId };
}

async function advanceToStarterPending(
  registration: PlayerRegistrationService,
  starter: PlayerStarterService,
  identity: string,
  regionId: string,
): Promise<PlayerId> {
  const resolved = unwrap(
    await registration.resolveOrCreatePlayer({ provider: "whatsapp", externalId: identity }),
  );
  unwrap(
    await registration.createProfile(resolved.playerId, { trainerName: "Red", locale: "pt-BR" }),
  );
  unwrap(await registration.selectRegion(resolved.playerId, { regionId }));
  unwrap(await starter.prepareStarterSelection(resolved.playerId));
  return resolved.playerId;
}

describe.sequential("Phase 5 player onboarding on disposable PostgreSQL", () => {
  const dbName = `pokemon_phase5_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 12 });
    await runMigrations(pool, { appliedBy: "phase5-vitest" });
    const client = await pool.connect();
    try {
      fixture = await seedFixture(client);
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("creates/resumes identity and grants exactly one starter under concurrent retries", async () => {
    const repository = new PostgresPlayerOnboardingRepository(pool);
    const registration = new PlayerRegistrationService(repository);
    const starter = new PlayerStarterService(
      repository,
      new ManualClock(new Date("2026-08-25T22:00:00.000Z")),
      new DeterministicRandomSource(1234),
    );

    const identity = { provider: "whatsapp", externalId: "phase5-player-a" };
    const [firstIdentity, secondIdentity] = await Promise.all([
      registration.resolveOrCreatePlayer(identity),
      registration.resolveOrCreatePlayer(identity),
    ]);
    const first = unwrap(firstIdentity);
    const second = unwrap(secondIdentity);
    expect(second.playerId).toBe(first.playerId);
    expect([first.created, second.created].sort()).toEqual([false, true]);

    unwrap(
      await registration.createProfile(first.playerId, { trainerName: "Red", locale: "pt-BR" }),
    );
    const badRegion = await registration.selectRegion(first.playerId, { regionId: randomUUID() });
    expect(badRegion).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    unwrap(await registration.selectRegion(first.playerId, { regionId: fixture.regionId }));

    const prepared = unwrap(await starter.prepareStarterSelection(first.playerId));
    const preparedRetry = unwrap(await starter.prepareStarterSelection(first.playerId));
    expect(preparedRetry.starterClaimKey).toBe(prepared.starterClaimKey);
    expect(prepared.options).toHaveLength(1);
    expect(prepared.options[0]?.formId).toBe(fixture.formId);

    const [grantA, grantB] = await Promise.all([
      starter.grantStarter(first.playerId, { formId: fixture.formId }, createCorrelationId()),
      starter.grantStarter(first.playerId, { formId: fixture.formId }, createCorrelationId()),
    ]);
    const grantedA = unwrap(grantA);
    const grantedB = unwrap(grantB);
    expect(grantedB.pokemonInstanceId).toBe(grantedA.pokemonInstanceId);
    expect([grantedA.replayed, grantedB.replayed].sort()).toEqual([false, true]);

    const counts = await pool.query<{
      pokemon_count: string;
      grant_count: string;
      roster_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM pokemon_instances WHERE owner_player_id = $1)::text AS pokemon_count,
         (SELECT count(*) FROM starter_grants WHERE player_id = $1)::text AS grant_count,
         (SELECT count(*) FROM pokemon_roster_slots WHERE player_id = $1)::text AS roster_count`,
      [first.playerId],
    );
    expect(counts.rows[0]).toMatchObject({
      pokemon_count: "1",
      grant_count: "1",
      roster_count: "1",
    });
    const starterPokedex = await pool.query<{
      seen_count: string;
      caught_count: string;
      first_seen_at: Date | null;
      last_seen_at: Date | null;
      first_caught_at: Date | null;
      last_caught_at: Date | null;
    }>(
      `SELECT seen_count::text, caught_count::text,
              first_seen_at, last_seen_at, first_caught_at, last_caught_at
       FROM player_pokedex_species
       WHERE player_id = $1 AND species_id = $2`,
      [first.playerId, fixture.speciesId],
    );
    expect(starterPokedex.rows[0]).toMatchObject({ seen_count: "1", caught_count: "1" });
    expect(starterPokedex.rows[0]?.first_seen_at).toBeInstanceOf(Date);
    expect(starterPokedex.rows[0]?.last_seen_at).toBeInstanceOf(Date);
    expect(starterPokedex.rows[0]?.first_caught_at).toBeInstanceOf(Date);
    expect(starterPokedex.rows[0]?.last_caught_at).toBeInstanceOf(Date);

    const immediateProfile = unwrap(await starter.getProfile(first.playerId));
    expect(immediateProfile.onboardingState).toBe("STARTER_GRANTED");
    expect(immediateProfile.team).toHaveLength(1);

    const afterRestart = new PlayerStarterService(
      repository,
      new ManualClock(new Date("2026-08-25T22:05:00.000Z")),
      new DeterministicRandomSource(9999),
    );
    unwrap(await afterRestart.completeOnboarding(first.playerId));
    const completed = unwrap(await afterRestart.getProfile(first.playerId));
    expect(completed.onboardingState).toBe("COMPLETE");
    expect(completed.starterPokemonInstanceId).toBe(grantedA.pokemonInstanceId);

    const disabled = await afterRestart.evaluateGameplayAccess(first.playerId, {
      enabled: false,
      reason: "maintenance",
    });
    expect(disabled).toMatchObject({ ok: false, error: { code: "FEATURE_UNAVAILABLE" } });
    expect(
      await afterRestart.evaluateGameplayAccess(first.playerId, { enabled: true, reason: null }),
    ).toEqual({ ok: true, value: undefined });

    const finalRetry = unwrap(
      await afterRestart.grantStarter(first.playerId, { formId: fixture.formId }),
    );
    expect(finalRetry.pokemonInstanceId).toBe(grantedA.pokemonInstanceId);
    expect(finalRetry.replayed).toBe(true);
    const starterPokedexAfterRetry = await pool.query<{
      seen_count: string;
      caught_count: string;
      first_seen_at: Date | null;
      last_seen_at: Date | null;
      first_caught_at: Date | null;
      last_caught_at: Date | null;
    }>(
      `SELECT seen_count::text, caught_count::text,
              first_seen_at, last_seen_at, first_caught_at, last_caught_at
       FROM player_pokedex_species
       WHERE player_id = $1 AND species_id = $2`,
      [first.playerId, fixture.speciesId],
    );
    expect(starterPokedexAfterRetry.rows[0]).toEqual(starterPokedex.rows[0]);
  }, 20_000);

  it("sends the starter to Box when all six team slots are already occupied", async () => {
    const repository = new PostgresPlayerOnboardingRepository(pool);
    const registration = new PlayerRegistrationService(repository);
    const starter = new PlayerStarterService(
      repository,
      new ManualClock(new Date("2026-08-25T22:10:00.000Z")),
      new DeterministicRandomSource(7),
    );
    const playerId = await advanceToStarterPending(
      registration,
      starter,
      "phase5-player-box",
      fixture.regionId,
    );

    for (let slot = 1; slot <= 6; slot += 1) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO pokemon_instances(id, owner_player_id, form_id, level, current_hp, origin_type)
         VALUES ($1, $2, $3, 5, 20, 'TEST')`,
        [id, playerId, fixture.formId],
      );
      await pool.query(
        `INSERT INTO pokemon_roster_slots(
           pokemon_instance_id, player_id, placement_kind, box_no, slot_no
         ) VALUES ($1, $2, 'TEAM', NULL, $3)`,
        [id, playerId, slot],
      );
    }

    const granted = unwrap(await starter.grantStarter(playerId, { formId: fixture.formId }));
    const placement = await pool.query<{ placement_kind: string; box_no: number; slot_no: number }>(
      `SELECT placement_kind, box_no, slot_no FROM pokemon_roster_slots
       WHERE pokemon_instance_id = $1`,
      [granted.pokemonInstanceId],
    );
    expect(placement.rows[0]).toMatchObject({ placement_kind: "BOX", box_no: 1, slot_no: 1 });
  });

  it("carries starter options when cloning a published release", async () => {
    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    const cloneId = randomUUID();
    unwrap(
      await catalog.clonePublishedRelease({
        parentReleaseId: fixture.releaseId,
        newReleaseId: cloneId,
        releaseNo: 99n,
        name: "phase5-starter-clone",
      }),
    );

    const cloned = await pool.query<{
      region_id: string;
      form_id: string;
      starter_level: number;
      sort_order: number;
    }>(
      `SELECT region_id, form_id, starter_level, sort_order
       FROM starter_options WHERE content_release_id = $1`,
      [cloneId],
    );
    expect(cloned.rows).toEqual([
      {
        region_id: fixture.regionId,
        form_id: fixture.formId,
        starter_level: 5,
        sort_order: 1,
      },
    ]);
  });

  it("keeps published starter options immutable", async () => {
    await expectPgCode(
      pool.query(
        "UPDATE starter_options SET sort_order = sort_order + 1 WHERE content_release_id = $1",
        [fixture.releaseId],
      ),
      "55000",
    );
  });
});
