import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPveSceneRoutes } from "../../src/modules/battle/pve-scene-whatsapp.js";
import { BattleService } from "../../src/modules/battle/service.js";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type { OutboundMessageAdapter } from "../../src/modules/messaging/ports.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { MessagingService, OutboxWorker } from "../../src/modules/messaging/service.js";
import { PostgresBattleCancellation } from "../../src/platform/battle/postgres-battle-cancellation.js";
import { PostgresBattleParticipantControllerRepository } from "../../src/platform/battle/postgres-battle-participant-controller-repository.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { PostgresBattleTurnWindowRepository } from "../../src/platform/battle/postgres-battle-turn-window-repository.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { simulatedWhatsAppMessage } from "../../src/runtime/compose-simulated-whatsapp-runtime.js";
import { ok } from "../../src/shared-kernel/result.js";
import type { EncounterSeedProvider, SeedMaterial } from "../../src/modules/encounter/ports.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPvpChallengeRepository } from "../../src/platform/pvp/postgres-pvp-challenge-repository.js";
import { PostgresPvpStartRepository } from "../../src/platform/pvp/postgres-pvp-start-repository.js";

const VALID_BATTLE_RULESET = {
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
    stabMultiplierBasisPoints: 15_000,
    damageRandomMinBasisPoints: 10_000,
    damageRandomMaxBasisPoints: 10_000,
    switchConsumesTurn: true,
  },
  capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 10_000 },
  defeat: { automaticMoneyLoss: false },
  narrative: { authority: "N0_FLAVOR_ONLY" },
} as const;

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

class CountingSeedProvider implements EncounterSeedProvider {
  public calls = 0;

  public create(): SeedMaterial {
    this.calls += 1;
    const seed = new Uint8Array(32).fill(this.calls);
    return {
      seed,
      envelope: {
        ciphertext: seed,
        iv: new Uint8Array(12).fill(2),
        authTag: new Uint8Array(16).fill(3),
        keyVersion: 1,
      },
    };
  }
}

interface CatalogFixture {
  readonly areaId: string;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly formId: string;
  readonly abilityId: string;
  readonly natureId: string;
  readonly moveId: string;
}

interface AcceptedMatchFixture {
  readonly challengeId: string;
  readonly encounterId: string;
  readonly challengerPlayerId: string;
  readonly targetPlayerId: string;
  readonly eligiblePokemonIds: readonly string[];
}

async function seedCatalog(pool: Pool): Promise<CatalogFixture> {
  const regionId = randomUUID();
  const areaId = randomUUID();
  const rulesetId = randomUUID();
  const contentReleaseId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const abilityId = randomUUID();
  const natureId = randomUUID();
  const moveId = randomUUID();
  const publishedAt = new Date("2026-08-31T12:00:00.000Z");

  await pool.query(
    `INSERT INTO rulesets(
       id, key, version, engine_contract_version, config, status
     ) VALUES ($1, $2, 1, 1, $3::jsonb, 'DRAFT')`,
    [rulesetId, `pvp-start-ruleset-${rulesetId}`, JSON.stringify(VALID_BATTLE_RULESET)],
  );
  await pool.query(
    `INSERT INTO content_releases(
       id, release_no, name, status, default_ruleset_id
     ) VALUES ($1, 28002, 'PVP start integration', 'DRAFT', $2)`,
    [contentReleaseId, rulesetId],
  );
  await pool.query("INSERT INTO regions(id, slug) VALUES ($1, $2)", [
    regionId,
    `pvp-start-region-${regionId}`,
  ]);
  await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
    areaId,
    regionId,
    `pvp-start-area-${areaId}`,
  ]);
  await pool.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, 'normal')", [typeId]);
  await pool.query("INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 900, $2)", [
    speciesId,
    `pvp-start-species-${speciesId}`,
  ]);
  await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
    formId,
    speciesId,
  ]);
  await pool.query("INSERT INTO abilities(id, slug) VALUES ($1, $2)", [
    abilityId,
    `pvp-start-ability-${abilityId}`,
  ]);
  await pool.query("INSERT INTO natures(id, slug) VALUES ($1, $2)", [
    natureId,
    `pvp-start-nature-${natureId}`,
  ]);
  await pool.query("INSERT INTO moves(id, slug) VALUES ($1, $2)", [
    moveId,
    `pvp-start-move-${moveId}`,
  ]);
  await pool.query(
    `INSERT INTO pokemon_form_revisions(
       id, content_release_id, form_id, display_name, type1_id,
       base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     ) VALUES ($1, $2, $3, 'Startmon', $4, 50, 50, 50, 50, 50, 50)`,
    [randomUUID(), contentReleaseId, formId, typeId],
  );
  await pool.query(
    `INSERT INTO ability_revisions(
       id, content_release_id, ability_id, display_name, effect_config
     ) VALUES ($1, $2, $3, 'Start Ability', '{}'::jsonb)`,
    [randomUUID(), contentReleaseId, abilityId],
  );
  await pool.query(
    `INSERT INTO nature_revisions(
       id, content_release_id, nature_id, display_name, increased_stat, decreased_stat
     ) VALUES ($1, $2, $3, 'Neutral', NULL, NULL)`,
    [randomUUID(), contentReleaseId, natureId],
  );
  await pool.query(
    `INSERT INTO move_revisions(
       id, content_release_id, move_id, display_name, type_id, category,
       power, accuracy, priority, max_pp, effect_config, flags
     ) VALUES (
       $1, $2, $3, 'Start Move', $4, 'PHYSICAL',
       40, 100, 0, 35, '{}'::jsonb,
       '{"schemaVersion":1,"makesContact":true}'::jsonb
     )`,
    [randomUUID(), contentReleaseId, moveId, typeId],
  );

  await pool.query(
    `UPDATE rulesets
     SET status = 'VALIDATED', validated_at = $2,
         validation_report = '{"test_fixture":true}'::jsonb,
         config_fingerprint = $3
     WHERE id = $1`,
    [rulesetId, publishedAt, "b".repeat(64)],
  );
  await pool.query(
    `UPDATE rulesets
     SET status = 'PUBLISHED', published_at = $2
     WHERE id = $1`,
    [rulesetId, publishedAt],
  );
  await pool.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = $2,
         validation_report = '{"test_fixture":true}'::jsonb,
         content_fingerprint = $3
     WHERE id = $1`,
    [contentReleaseId, publishedAt, "c".repeat(64)],
  );
  await pool.query(
    `UPDATE content_releases
     SET status = 'PUBLISHED', published_at = $2
     WHERE id = $1`,
    [contentReleaseId, publishedAt],
  );

  return {
    areaId,
    contentReleaseId,
    rulesetId,
    formId,
    abilityId,
    natureId,
    moveId,
  };
}

async function seedPlayer(
  pool: Pool,
  catalog: CatalogFixture,
  currentHps: readonly number[],
): Promise<{ playerId: string; pokemonIds: readonly string[] }> {
  const playerId = randomUUID();
  await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  await pool.query(
    `INSERT INTO onboarding_states(player_id, state, starter_claim_key, completed_at)
     VALUES ($1, 'COMPLETE', $2, now())`,
    [playerId, `pvp-start-starter-${playerId}`],
  );
  await pool.query(
    `INSERT INTO player_identities(id, player_id, provider, external_id, status)
     VALUES ($1, $2, 'WHATSAPP', $3, 'ACTIVE')`,
    [randomUUID(), playerId, `pvp-start-${playerId}`],
  );
  await pool.query("INSERT INTO player_locations(player_id, area_id) VALUES ($1, $2)", [
    playerId,
    catalog.areaId,
  ]);

  const pokemonIds: string[] = [];
  for (const [index, currentHp] of currentHps.entries()) {
    const pokemonId = randomUUID();
    pokemonIds.push(pokemonId);
    await pool.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, level, current_hp, ability_id,
         origin_type, status
       ) VALUES ($1, $2, $3, 10, $4, $5, 'PVP_TEST', 'ACTIVE')`,
      [pokemonId, playerId, catalog.formId, currentHp, catalog.abilityId],
    );
    await pool.query(
      `INSERT INTO pokemon_training_values(
         pokemon_instance_id, nature_id,
         iv_hp, iv_attack, iv_defense, iv_sp_attack, iv_sp_defense, iv_speed
       ) VALUES ($1, $2, 10, 10, 10, 10, 10, 10)`,
      [pokemonId, catalog.natureId],
    );
    await pool.query(
      `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
       VALUES ($1, 1, $2, 35)`,
      [pokemonId, catalog.moveId],
    );
    await pool.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES ($1, $2, 'TEAM', NULL, $3)`,
      [pokemonId, playerId, index + 1],
    );
  }
  return { playerId, pokemonIds };
}

async function seedAcceptedMatch(
  pool: Pool,
  catalog: CatalogFixture,
  challengerHps: readonly number[] = [20, 18],
  targetHps: readonly number[] = [20, 0],
): Promise<AcceptedMatchFixture> {
  const challenger = await seedPlayer(pool, catalog, challengerHps);
  const target = await seedPlayer(pool, catalog, targetHps);
  const challengeId = randomUUID();
  const encounterId = randomUUID();
  const acceptedAt = new Date("2026-08-31T12:01:00.000Z");

  await pool.query(
    `INSERT INTO encounters(
       id, player_id, area_id, status, content_release_id, ruleset_id, mode,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
       rng_counter, revision, creation_idempotency_key, created_at, updated_at, expires_at
     ) VALUES (
       $1, $2, $3, 'PRESENTED', $4, $5, 'PVP',
       $6, $7, $8, 1, 0, 0, $9, $10, $10, NULL
     )`,
    [
      encounterId,
      challenger.playerId,
      catalog.areaId,
      catalog.contentReleaseId,
      catalog.rulesetId,
      Buffer.alloc(32, 11),
      Buffer.alloc(12, 12),
      Buffer.alloc(16, 13),
      `pvp-challenge:${challengeId}`,
      acceptedAt,
    ],
  );
  await pool.query(
    `INSERT INTO encounter_players(encounter_id, player_id, side_no, role, active)
     VALUES
       ($1, $2, 1, 'CHALLENGER', TRUE),
       ($1, $3, 2, 'TARGET', TRUE)`,
    [encounterId, challenger.playerId, target.playerId],
  );
  await pool.query(
    `INSERT INTO pvp_challenges(
       id, challenger_player_id, target_player_id, status, format_key, reach_policy,
       area_id, content_release_id, ruleset_id, creation_idempotency_key,
       request_fingerprint, encounter_id, battle_id, revision,
       created_at, updated_at, expires_at, accepted_at, started_at, closed_at
     ) VALUES (
       $1, $2, $3, 'ACCEPTED', '1V1', 'SAME_AREA',
       $4, $5, $6, $7,
       $8, $9, NULL, 1,
       $10, $11, $12, $11, NULL, NULL
     )`,
    [
      challengeId,
      challenger.playerId,
      target.playerId,
      catalog.areaId,
      catalog.contentReleaseId,
      catalog.rulesetId,
      `start-create-${challengeId}`,
      "a".repeat(64),
      encounterId,
      new Date("2026-08-31T12:00:00.000Z"),
      acceptedAt,
      new Date("2026-08-31T12:05:00.000Z"),
    ],
  );

  return {
    challengeId,
    encounterId,
    challengerPlayerId: challenger.playerId,
    targetPlayerId: target.playerId,
    eligiblePokemonIds: [
      ...challenger.pokemonIds.filter((_, index) => (challengerHps[index] ?? 0) > 0),
      ...target.pokemonIds.filter((_, index) => (targetHps[index] ?? 0) > 0),
    ],
  };
}

describe("PVP START PostgreSQL atomicity", () => {
  const dbName = `pokemon_pvp_start_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let catalog: CatalogFixture;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 12 });
    await runMigrations(pool, { appliedBy: "flow003-pvp-start-vitest" });
    catalog = await seedCatalog(pool);
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

  it("serializes concurrent START calls into one Battle snapshot and one initial TurnWindow", async () => {
    const fixture = await seedAcceptedMatch(pool, catalog);
    const seedProvider = new CountingSeedProvider();
    const repository = new PostgresPvpStartRepository(pool, seedProvider);
    const startedAt = new Date("2026-08-31T12:02:00.000Z");
    const deadlineAt = new Date("2026-08-31T12:07:00.000Z");

    const [challengerStart, targetStart] = await Promise.all([
      repository.start({
        challengeId: fixture.challengeId,
        actorPlayerId: fixture.challengerPlayerId,
        startedAt,
        deadlineAt,
      }),
      repository.start({
        challengeId: fixture.challengeId,
        actorPlayerId: fixture.targetPlayerId,
        startedAt,
        deadlineAt,
      }),
    ]);

    expect(challengerStart.ok).toBe(true);
    expect(targetStart.ok).toBe(true);
    if (!challengerStart.ok || !targetStart.ok) return;

    expect(challengerStart.value.challengeId).toBe(fixture.challengeId);
    expect(targetStart.value.challengeId).toBe(fixture.challengeId);
    expect(targetStart.value.encounterId).toBe(challengerStart.value.encounterId);
    expect(targetStart.value.battleId).toBe(challengerStart.value.battleId);
    expect(targetStart.value.turnWindowId).toBe(challengerStart.value.turnWindowId);
    expect(new Set([challengerStart.value.replayed, targetStart.value.replayed])).toEqual(
      new Set([false, true]),
    );
    expect(seedProvider.calls).toBe(1);

    const battleId = challengerStart.value.battleId;
    const challenge = await pool.query<{ status: string; battle_id: string | null }>(
      "SELECT status, battle_id FROM pvp_challenges WHERE id = $1",
      [fixture.challengeId],
    );
    expect(challenge.rows[0]).toEqual({ status: "STARTED", battle_id: battleId });
    const pending = await new PostgresPvpChallengeRepository(pool).read((transaction) =>
      transaction.actionableChallengeForTarget(fixture.targetPlayerId),
    );
    expect(pending).toBeNull();

    const encounter = await pool.query<{ status: string }>(
      "SELECT status FROM encounters WHERE id = $1",
      [fixture.encounterId],
    );
    expect(encounter.rows[0]?.status).toBe("IN_BATTLE");

    const battles = await pool.query<{
      id: string;
      battle_type: string;
      status: string;
      encounter_id: string | null;
    }>(
      `SELECT id, battle_type, status, encounter_id
       FROM battles
       WHERE encounter_id = $1`,
      [fixture.encounterId],
    );
    expect(battles.rows).toEqual([
      {
        id: battleId,
        battle_type: "PVP",
        status: "ACTIVE",
        encounter_id: fixture.encounterId,
      },
    ]);

    const sides = await pool.query<{ side_no: number; controller_kind: string; player_id: string }>(
      `SELECT side_no, controller_kind, player_id
       FROM battle_sides
       WHERE battle_id = $1
       ORDER BY side_no`,
      [battleId],
    );
    expect(sides.rows).toEqual([
      { side_no: 1, controller_kind: "PLAYER", player_id: fixture.challengerPlayerId },
      { side_no: 2, controller_kind: "PLAYER", player_id: fixture.targetPlayerId },
    ]);

    const participants = await pool.query<{ pokemon_instance_id: string }>(
      `SELECT pokemon_instance_id
       FROM battle_participants
       WHERE battle_id = $1
       ORDER BY pokemon_instance_id`,
      [battleId],
    );
    expect(participants.rows.map((row) => row.pokemon_instance_id).sort()).toEqual(
      [...fixture.eligiblePokemonIds].sort(),
    );

    const controllers = await pool.query<{
      participant_id: string;
      kind: string;
      player_id: string | null;
    }>(
      `SELECT participant_id, kind, player_id
       FROM battle_participant_controllers
       WHERE battle_id = $1
       ORDER BY participant_id`,
      [battleId],
    );
    expect(controllers.rows).toHaveLength(participants.rows.length);
    expect(controllers.rows.every((row) => row.kind === "PLAYER" && row.player_id !== null)).toBe(
      true,
    );
    expect(new Set(controllers.rows.map((row) => row.player_id))).toEqual(
      new Set([fixture.challengerPlayerId, fixture.targetPlayerId]),
    );

    const snapshots = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM battle_state_snapshots WHERE battle_id = $1 AND version = 0",
      [battleId],
    );
    expect(snapshots.rows[0]?.count).toBe("1");

    const windows = await pool.query<{
      id: string;
      status: string;
      required_controllers: unknown | null;
    }>(
      `SELECT id, status, required_controllers
       FROM battle_turn_windows
       WHERE battle_id = $1 AND battle_version = 0`,
      [battleId],
    );
    expect(windows.rows).toHaveLength(1);
    expect(windows.rows[0]).toMatchObject({
      id: challengerStart.value.turnWindowId,
      status: "COLLECTING",
    });
    expect(windows.rows[0]?.required_controllers).not.toBeNull();
    const required = await pool.query<{ player_id: string }>(
      `SELECT player_id
       FROM battle_turn_window_required_players
       WHERE turn_window_id = $1
       ORDER BY player_id`,
      [challengerStart.value.turnWindowId],
    );
    expect(required.rows.map((row) => row.player_id).sort()).toEqual(
      [fixture.challengerPlayerId, fixture.targetPlayerId].sort(),
    );
  }, 30_000);

  it("simulates two distinct trainers through messages, waiting, restart, resolution and surrender", async () => {
    const fixture = await seedAcceptedMatch(pool, catalog, [20, 18], [20, 17]);
    const started = await new PostgresPvpStartRepository(pool, new CountingSeedProvider()).start({
      challengeId: fixture.challengeId,
      actorPlayerId: fixture.targetPlayerId,
      startedAt: new Date("2026-10-24T18:00:00.000Z"),
      deadlineAt: new Date("2026-10-24T18:05:00.000Z"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const battleId = started.value.battleId;
    const playerRefs = new Map([
      ["trainer-one@s.whatsapp.net", fixture.challengerPlayerId],
      ["trainer-two@s.whatsapp.net", fixture.targetPlayerId],
    ]);
    const services = () => {
      const battle = new BattleService(new PostgresBattleRepository(pool), {
        decrypt: () => Buffer.alloc(32, 1),
      });
      const cancellation = new PostgresBattleCancellation(pool);
      const controllers = new PostgresBattleParticipantControllerRepository(pool);
      const windows = new PostgresBattleTurnWindowRepository(pool);
      const router = new MessageRouter(
        createPveSceneRoutes({
          players: {
            resolvePlayer: async ({ externalId }: { externalId: string }) =>
              ok({ playerId: playerRefs.get(externalId) }),
          },
          activeBattleId: async (playerId: string) =>
            [...playerRefs.values()].includes(playerId) ? battleId : null,
          battle: {
            currentState: battle.currentState.bind(battle),
            resolvePlayerTurn: battle.resolvePlayerTurn.bind(battle),
            surrenderPvp: async (input: {
              battleId: string;
              playerId: string;
              expectedVersion: number;
            }) => {
              const result = await cancellation.surrenderPvp(input);
              return result.kind === "PERSISTED" || result.kind === "REPLAYED"
                ? ok({ state: result.state })
                : { ok: false, error: { code: "BATTLE_STATE_INVALID", message: result.kind } };
            },
          },
          controllers,
          turnWindowForBattleVersion: async (id: string, version: number) => {
            const value = await windows.loadByBattleVersion(id, version);
            return value.ok ? value.value : null;
          },
          presentation: {
            speciesDisplayName: async () => "Startmon",
            moveDisplayNames: async () => new Map([[catalog.moveId, "Start Move"]]),
          },
          playerExternalRef: async (id: string) =>
            [...playerRefs.entries()].find(([, value]) => value === id)?.[0] ?? null,
          admins: { resolvePrincipal: async () => null },
        } as never),
        { authorize: async () => ok(undefined) },
      );
      const messages = new PostgresMessagingRepository(pool);
      return {
        service: new MessagingService(messages, router),
        worker: new OutboxWorker(messages, [adapter], {
          batchSize: 20,
          staleAfterMs: 30_000,
          maxAttempts: 3,
          baseBackoffMs: 1,
          maxBackoffMs: 10,
        }),
      };
    };

    const outbox: PendingOutboxMessage[] = [];
    const adapter: OutboundMessageAdapter = {
      channel: "whatsapp",
      async send(message) {
        outbox.push(message);
        return { providerExternalMessageId: `simulated:${message.id}` };
      },
    };
    let runtime = services();
    const incoming = (senderRef: string, text: string, externalMessageId: string) =>
      simulatedWhatsAppMessage({
        senderRef,
        chatRef: "pvp-shadow-test@g.us",
        text,
        externalMessageId,
        occurredAt: "2026-10-24T18:01:00.000Z",
      });
    const send = async (senderRef: string, text: string, id: string) => {
      const result = await runtime.service.receive(incoming(senderRef, text, id));
      expect(result).toMatchObject({ ok: true, value: { status: "PROCESSED" } });
      const flushed = await runtime.worker.runOnce();
      expect(flushed.failed).toBe(0);
      return outbox.slice(-flushed.sent);
    };

    const firstHud = await send("trainer-one@s.whatsapp.net", "/batalha", "pvp-hud-a");
    const secondHud = await send("trainer-two@s.whatsapp.net", "/batalha", "pvp-hud-b");
    expect(firstHud[0]?.payload.text).toContain("◇ *𝗣𝗥Ó𝗫𝗜𝗠𝗔 𝗔ÇÃ𝗢*");
    expect(secondHud[0]?.payload.text).toContain("`/moves`");
    expect(firstHud[0]?.payload.text).not.toContain("`/fugir`");
    const moves = await send("trainer-one@s.whatsapp.net", "/moves", "pvp-moves-a");
    expect(moves[0]?.payload.text).toContain("Start Move");

    const actionA = incoming("trainer-one@s.whatsapp.net", "/movimento 1", "pvp-move-a");
    expect(await runtime.service.receive(actionA)).toMatchObject({
      ok: true,
      value: { status: "PROCESSED" },
    });
    expect(await runtime.worker.runOnce()).toMatchObject({ failed: 0 });
    const pendingState = await pool.query<{ version: string }>(
      "SELECT version::text FROM battles WHERE id=$1",
      [battleId],
    );
    expect(pendingState.rows[0]?.version).toBe("0");

    const waiting = await send("trainer-one@s.whatsapp.net", "/batalha", "pvp-hud-wait");
    expect(waiting[0]?.payload.text).toContain("Sua ação já foi definida");
    expect(waiting[0]?.payload.text).toContain("adversário permanece oculta");
    const other = await send("trainer-two@s.whatsapp.net", "/batalha", "pvp-hud-other");
    expect(other[0]?.payload.text).toContain("Sua ação ainda não foi definida");
    expect(other[0]?.payload.text).not.toContain("Sua ação já foi definida");

    // A logical restart must retain the pending submission and Outbox receipts.
    runtime = services();
    expect(await runtime.service.receive(actionA)).toMatchObject({
      ok: true,
      value: { status: "REPLAYED" },
    });
    expect(await runtime.worker.runOnce()).toMatchObject({ failed: 0, sent: 0 });
    const resolved = await send("trainer-two@s.whatsapp.net", "/movimento 1", "pvp-move-b");
    expect(resolved.some((message) => message.messageType === "TEXT")).toBe(true);
    const after = await pool.query<{ version: string; status: string }>(
      "SELECT version::text, status FROM battles WHERE id=$1",
      [battleId],
    );
    expect(after.rows[0]).toMatchObject({ version: "1", status: "ACTIVE" });
    const initial = await pool.query<{ status: string }>(
      "SELECT status FROM battle_turn_windows WHERE id=$1",
      [started.value.turnWindowId],
    );
    expect(initial.rows[0]?.status).toBe("COMMITTED");

    await send("trainer-one@s.whatsapp.net", "/desistir", "pvp-surrender-a");
    const ending = await pool.query<{ status: string }>("SELECT status FROM battles WHERE id=$1", [
      battleId,
    ]);
    expect(ending.rows[0]?.status).toBe("LOST");
    expect(
      await runtime.service.receive(
        incoming("trainer-one@s.whatsapp.net", "/desistir", "pvp-surrender-a"),
      ),
    ).toMatchObject({ ok: true, value: { status: "REPLAYED" } });
    const battles = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM battles WHERE encounter_id=$1",
      [fixture.encounterId],
    );
    expect(battles.rows[0]?.count).toBe("1");
  }, 45_000);

  it("rejects START when either player has no living eligible TEAM Pokemon", async () => {
    const fixture = await seedAcceptedMatch(pool, catalog, [20], [0]);
    const seedProvider = new CountingSeedProvider();
    const repository = new PostgresPvpStartRepository(pool, seedProvider);

    const result = await repository.start({
      challengeId: fixture.challengeId,
      actorPlayerId: fixture.challengerPlayerId,
      startedAt: new Date("2026-08-31T12:02:00.000Z"),
      deadlineAt: new Date("2026-08-31T12:07:00.000Z"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLAYER_INELIGIBLE");
    expect(seedProvider.calls).toBe(0);
  });

  it("rolls back Battle, snapshot and lifecycle links when TurnWindow creation fails", async () => {
    const fixture = await seedAcceptedMatch(pool, catalog, [20], [20]);
    const seedProvider = new CountingSeedProvider();
    const repository = new PostgresPvpStartRepository(pool, seedProvider);

    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_pvp_start_turn_window()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'forced turn-window failure';
      END;
      $$;
      CREATE TRIGGER trg_fail_pvp_start_turn_window
      BEFORE INSERT ON battle_turn_windows
      FOR EACH ROW EXECUTE FUNCTION fail_pvp_start_turn_window();
    `);

    try {
      await expect(
        repository.start({
          challengeId: fixture.challengeId,
          actorPlayerId: fixture.targetPlayerId,
          startedAt: new Date("2026-08-31T12:02:00.000Z"),
          deadlineAt: new Date("2026-08-31T12:07:00.000Z"),
        }),
      ).rejects.toThrow("forced turn-window failure");
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS trg_fail_pvp_start_turn_window ON battle_turn_windows",
      );
      await pool.query("DROP FUNCTION IF EXISTS fail_pvp_start_turn_window() CASCADE");
    }

    const challenge = await pool.query<{
      status: string;
      battle_id: string | null;
    }>("SELECT status, battle_id FROM pvp_challenges WHERE id = $1", [fixture.challengeId]);
    expect(challenge.rows[0]).toEqual({ status: "ACCEPTED", battle_id: null });

    const encounter = await pool.query<{ status: string }>(
      "SELECT status FROM encounters WHERE id = $1",
      [fixture.encounterId],
    );
    expect(encounter.rows[0]?.status).toBe("PRESENTED");

    const battleCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM battles WHERE encounter_id = $1",
      [fixture.encounterId],
    );
    expect(battleCount.rows[0]?.count).toBe("0");

    // Retry the same accepted encounter after the failed transaction is gone.
    const challenges = new PostgresPvpChallengeRepository(pool);
    const resumable = await challenges.read((transaction) =>
      transaction.actionableChallengeForTarget(fixture.targetPlayerId),
    );
    expect(resumable?.id).toBe(fixture.challengeId);
    expect(resumable?.status).toBe("ACCEPTED");
    const resumed = await repository.start({
      challengeId: fixture.challengeId,
      actorPlayerId: fixture.targetPlayerId,
      startedAt: new Date("2026-08-31T12:03:00.000Z"),
      deadlineAt: new Date("2026-08-31T12:08:00.000Z"),
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const restarted = await repository.start({
      challengeId: fixture.challengeId,
      actorPlayerId: fixture.targetPlayerId,
      startedAt: new Date("2026-08-31T12:03:00.000Z"),
      deadlineAt: new Date("2026-08-31T12:08:00.000Z"),
    });
    expect(restarted).toMatchObject({
      ok: true,
      value: { battleId: resumed.value.battleId, replayed: true },
    });
    expect(
      await challenges.read((transaction) =>
        transaction.actionableChallengeForTarget(fixture.targetPlayerId),
      ),
    ).toBeNull();
    const finalBattleCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM battles WHERE encounter_id = $1",
      [fixture.encounterId],
    );
    expect(finalBattleCount.rows[0]?.count).toBe("1");
  }, 30_000);
});
