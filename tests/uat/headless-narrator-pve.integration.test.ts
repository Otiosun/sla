import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeBaileysMessage } from "../../src/adapters/whatsapp/baileys-normalizer.js";
import { UatBootstrapService } from "../../src/modules/admin/uat-bootstrap.js";
import { BattleService } from "../../src/modules/battle/service.js";
import { CaptureService } from "../../src/modules/capture/service.js";
import { EncounterService } from "../../src/modules/encounter/service.js";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type { OutboundMessageAdapter } from "../../src/modules/messaging/ports.js";
import { MessagingService, OutboxWorker } from "../../src/modules/messaging/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { SystemClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEncounterRepository } from "../../src/platform/encounter/postgres-encounter-repository.js";
import { createDirectEncounterEffect } from "../../src/platform/exploration/expedition-direct-encounter-effect.js";
import { PublishedSearchOutcomePolicy } from "../../src/platform/exploration/expedition-published-outcome-policy.js";
import { PostgresExpeditionRepository } from "../../src/platform/exploration/postgres-expedition-repository.js";
import { PostgresExpeditionV4StagingSearch } from "../../src/platform/exploration/postgres-expedition-v4-search.js";
import { PostgresExpeditionV4StagingTrailFollow } from "../../src/platform/exploration/postgres-expedition-v4-trail.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { PostgresPlayerAccessRepository } from "../../src/platform/registration/postgres-player-access-repository.js";
import { AesEncounterSeedProvider } from "../../src/platform/rng/encrypted-seed-provider.js";
import { CryptoRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import { PostgresFishingAttemptRepository } from "../../src/platform/world-services/postgres-fishing-attempt-repository.js";
import { createPveBattleRuntime } from "../../src/runtime/compose-pve-battle-runtime.js";
import { createOperationalSimulatedWhatsAppRuntime } from "../../src/runtime/compose-simulated-whatsapp-runtime.js";
import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";
import { parsePlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err } from "../../src/shared-kernel/result.js";

const maintenanceUrl = (() => {
  const value = process.env.POSTGRES_INTEGRATION_TEST_URL;
  if (value === undefined) {
    throw new Error("POSTGRES_INTEGRATION_TEST_URL is required");
  }
  const parsed = new URL(value);
  if (parsed.pathname !== "/postgres") {
    throw new Error("POSTGRES_INTEGRATION_TEST_URL must target /postgres");
  }
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("ALLOW_DISPOSABLE_POSTGRES_TESTS=1 is required");
  }
  return parsed;
})();

const CHAT = "120363777700000001@g.us";
const NARRATOR = "5511999990001@s.whatsapp.net";
const PLAYER = "5511999990002@s.whatsapp.net";
const PLAYER_LID = "123456789012345@lid";
const aliases = new Map([[PLAYER_LID, PLAYER]]);
const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

interface Fixture {
  readonly yun: string;
  readonly releaseId: string;
  readonly areaId: string;
  readonly itemId: string;
  readonly currencyId: string;
  readonly narratorPrincipalId: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function seedFixture(client: PoolClient): Promise<Fixture> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const moveId = randomUUID();
  const abilityId = randomUUID();
  const natureId = randomUUID();
  const tableId = randomUUID();
  const tableRevisionId = randomUUID();
  const itemId = randomUUID();
  const groupId = randomUUID();
  const narratorPrincipalId = randomUUID();
  const roleId = randomUUID();
  const capabilityId = randomUUID();

  const rulesetConfig = {
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
    capture: {
      model: "POKEMON_INSPIRED_V1",
      maxProbabilityBasisPoints: 10_000,
      allowedEncounterStates: ["ENGAGED", "IN_BATTLE"],
    },
    encounter: { expirationSeconds: 600 },
    defeat: { automaticMoneyLoss: false },
    narrative: { authority: "N0_FLAVOR_ONLY" },
  };

  await client.query(
    `INSERT INTO rulesets(
       id,key,version,engine_contract_version,config,status
     ) VALUES ($1,'headless-pve-uat',1,1,$2::jsonb,'DRAFT')`,
    [rulesetId, JSON.stringify(rulesetConfig)],
  );
  await client.query(
    `UPDATE rulesets
     SET status='VALIDATED',
         validated_at=now(),
         validation_report='{"valid":true,"issues":[]}'::jsonb,
         config_fingerprint=$2
     WHERE id=$1`,
    [rulesetId, "a".repeat(64)],
  );
  await client.query("UPDATE rulesets SET status='PUBLISHED', published_at=now() WHERE id=$1", [
    rulesetId,
  ]);
  await client.query(
    `INSERT INTO content_releases(
       id,release_no,name,status,default_ruleset_id
     ) VALUES ($1,9001,'Headless PVE UAT','DRAFT',$2)`,
    [releaseId, rulesetId],
  );

  await client.query("INSERT INTO pokemon_types(id,slug) VALUES ($1,'uat-normal')", [typeId]);
  await client.query(
    "INSERT INTO pokemon_species(id,national_dex,slug) VALUES ($1,69,'uat-bellsprout')",
    [speciesId],
  );
  await client.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES ($1,$2,'default')", [
    formId,
    speciesId,
  ]);
  await client.query("INSERT INTO moves(id,slug) VALUES ($1,'uat-tackle')", [moveId]);
  await client.query("INSERT INTO abilities(id,slug) VALUES ($1,'uat-chlorophyll')", [abilityId]);
  await client.query("INSERT INTO natures(id,slug) VALUES ($1,'uat-hardy')", [natureId]);
  await client.query("INSERT INTO regions(id,slug) VALUES ($1,'zhoulia')", [regionId]);
  await client.query("INSERT INTO areas(id,region_id,slug) VALUES ($1,$2,'vila-dos-arrozais')", [
    areaId,
    regionId,
  ]);
  await client.query("INSERT INTO items(id,slug) VALUES ($1,'uat-poke-ball')", [itemId]);

  await client.query(
    `INSERT INTO pokemon_type_revisions(id,content_release_id,type_id,display_name)
     VALUES ($1,$2,$3,'Normal')`,
    [randomUUID(), releaseId, typeId],
  );
  await client.query(
    `INSERT INTO pokemon_species_revisions(
       id,content_release_id,species_id,display_name,catch_rate,base_exp
     ) VALUES ($1,$2,$3,'Bellsprout',255,60)`,
    [randomUUID(), releaseId, speciesId],
  );
  await client.query(
    `INSERT INTO pokemon_form_revisions(
       id,content_release_id,form_id,display_name,type1_id,
       base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed
     ) VALUES ($1,$2,$3,'Bellsprout',$4,50,75,35,70,30,40)`,
    [randomUUID(), releaseId, formId, typeId],
  );
  await client.query(
    `INSERT INTO move_revisions(
       id,content_release_id,move_id,display_name,type_id,category,
       power,accuracy,priority,max_pp
     ) VALUES ($1,$2,$3,'Tackle',$4,'PHYSICAL',40,100,0,35)`,
    [randomUUID(), releaseId, moveId, typeId],
  );
  await client.query(
    `INSERT INTO ability_revisions(
       id,content_release_id,ability_id,display_name
     ) VALUES ($1,$2,$3,'Chlorophyll')`,
    [randomUUID(), releaseId, abilityId],
  );
  await client.query(
    `INSERT INTO nature_revisions(
       id,content_release_id,nature_id,display_name
     ) VALUES ($1,$2,$3,'Hardy')`,
    [randomUUID(), releaseId, natureId],
  );
  await client.query(
    `INSERT INTO region_revisions(
       id,content_release_id,region_id,display_name,active,data
     ) VALUES ($1,$2,$3,'Zhoulia',TRUE,'{}'::jsonb)`,
    [randomUUID(), releaseId, regionId],
  );
  await client.query(
    `INSERT INTO area_revisions(
       id,content_release_id,area_id,display_name,active,data
     ) VALUES (
       $1,$2,$3,'Vila dos Arrozais',TRUE,
       '{"schemaVersion":1,"kind":"TOWN","safePoint":true,"startingArea":true,"relocationPriority":0,"facilities":["POKEMON_CENTER","POKEMART"],"fishing":{"pointName":"Synthetic proof pond","encounterTables":{"COMMON":"grass","UNCOMMON":"grass"}}}'::jsonb
     )`,
    [randomUUID(), releaseId, areaId],
  );
  await client.query(
    `INSERT INTO pokemon_form_ability_options(
       id,content_release_id,form_id,ability_id,slot_kind
     ) VALUES ($1,$2,$3,$4,'PRIMARY')`,
    [randomUUID(), releaseId, formId, abilityId],
  );
  await client.query(
    `INSERT INTO move_learnset_entries(
       id,content_release_id,form_id,move_id,learn_method
     ) VALUES ($1,$2,$3,$4,'START')`,
    [randomUUID(), releaseId, formId, moveId],
  );
  await client.query(
    `INSERT INTO starter_options(
       id,content_release_id,region_id,form_id,starter_level,sort_order
     ) VALUES ($1,$2,$3,$4,5,1)`,
    [randomUUID(), releaseId, regionId, formId],
  );

  await client.query(
    `INSERT INTO encounter_tables(id,area_id,slug)
     VALUES ($1,$2,'grass')`,
    [tableId, areaId],
  );
  await client.query(
    `INSERT INTO encounter_table_revisions(
       id,content_release_id,encounter_table_id,active,conditions
     ) VALUES (
       $1,$2,$3,TRUE,
       '{"schemaVersion":1,"requiredUnlockKeys":[],"blockedUnlockKeys":[]}'::jsonb
     )`,
    [tableRevisionId, releaseId, tableId],
  );
  await client.query(
    `INSERT INTO encounter_entries(
       id,encounter_table_revision_id,form_id,weight,min_level,max_level,active,conditions
     ) VALUES (
       $1,$2,$3,100,3,4,TRUE,
       '{"schemaVersion":1,"requiredUnlockKeys":[],"blockedUnlockKeys":[]}'::jsonb
     )`,
    [randomUUID(), tableRevisionId, formId],
  );

  await client.query(
    `INSERT INTO item_revisions(
       id,content_release_id,item_id,display_name,item_kind,effect_key,effect_config,active
     ) VALUES (
       $1,$2,$3,'Poké Ball','BALL','catch-modifier',
       '{"multiplierBasisPoints":100000}'::jsonb,TRUE
     )`,
    [randomUUID(), releaseId, itemId],
  );

  // Only this disposable release has these prices and travel minutes.
  const currencyId = randomUUID();
  await client.query(
    "INSERT INTO currency_definitions(id,slug,display_name,allows_negative) VALUES($1,'uat-mart','UAT money',false)",
    [currencyId],
  );
  await client.query(
    `INSERT INTO item_purchase_offers(id,content_release_id,offer_key,item_id,currency_id,item_quantity,price_amount,sort_order)
    VALUES($1,$2,'shop.poke-ball',$3,$4,1,23,1)`,
    [randomUUID(), releaseId, itemId, currencyId],
  );
  await client.query(
    `INSERT INTO item_sale_offers(id,content_release_id,offer_key,item_id,currency_id,sale_amount,sort_order)
    VALUES($1,$2,'shop.sell.poke-ball',$3,$4,11,1)`,
    [randomUUID(), releaseId, itemId, currencyId],
  );
  const yun = randomUUID();
  await client.query("INSERT INTO areas(id,region_id,slug) VALUES($1,$2,'campos-de-yun')", [
    yun,
    regionId,
  ]);
  await client.query(
    `INSERT INTO area_revisions(id,content_release_id,area_id,display_name,active,data)
    VALUES($1,$2,$3,'Campos de Yun',true,'{"schemaVersion":1,"kind":"ROUTE","safePoint":false,"startingArea":false,"relocationPriority":10}')`,
    [randomUUID(), releaseId, yun],
  );
  for (const [from, to, minutes] of [
    [areaId, yun, 7],
    [yun, areaId, 9],
  ] as const) {
    const connection = randomUUID();
    await client.query(
      "INSERT INTO area_connections(id,from_area_id,to_area_id,connection_key) VALUES($1,$2,$3,$4)",
      [connection, from, to, "synthetic-" + minutes],
    );
    await client.query(
      `INSERT INTO area_connection_revisions(id,content_release_id,connection_id,access_rule,active)
      VALUES($1,$2,$3,$4::jsonb,true)`,
      [
        randomUUID(),
        releaseId,
        connection,
        JSON.stringify({
          schemaVersion: 1,
          requiredUnlockKeys: from === yun ? ["proof.blackout.lock"] : [],
          explorationMinutes: minutes,
        }),
      ],
    );
  }

  // Deliberately synthetic policies; never published outside this owned fixture.
  for (const period of ["DAY", "NIGHT"]) {
    await client.query(
      "INSERT INTO solo_search_outcome_policies(id,content_release_id,area_id,period,weights) VALUES($1,$2,$3,$4,$5::jsonb)",
      [
        randomUUID(),
        releaseId,
        areaId,
        period,
        JSON.stringify({ NO_SIGNAL: 0, TRAIL: 0, INCIDENTAL: 10000, DIRECT: 0 }),
      ],
    );
    await client.query(
      "INSERT INTO solo_resource_loot_policies(id,content_release_id,area_id,period,entries,approval_ref,approved_at) VALUES($1,$2,$3,$4,$5::jsonb,'SYNTHETIC TEST ONLY',now())",
      [randomUUID(), releaseId, areaId, period, JSON.stringify([{ kind: "NONE", weight: 10000 }])],
    );
  }
  await client.query(
    "INSERT INTO solo_report_reward_policies(content_release_id,config,approval_ref,approved_at) VALUES($1,$2::jsonb,'SYNTHETIC REPORT POLICY ONLY',now())",
    [
      releaseId,
      JSON.stringify({
        base: [{ kind: "ITEM", itemId, quantity: "1" }],
        normal: [{ weight: 10000, reward: { kind: "ITEM", itemId, quantity: "1" } }],
        highlight: [{ weight: 10000, reward: { kind: "TRAINER_POINTS", amount: 25 } }],
      }),
    ],
  );
  await client.query(
    `UPDATE content_releases
     SET status='VALIDATED',
         validated_at=now(),
         validation_report='{"valid":true,"issues":[]}'::jsonb,
         content_fingerprint=$2
     WHERE id=$1`,
    [releaseId, "b".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status='PUBLISHED', published_at=now() WHERE id=$1",
    [releaseId],
  );
  await client.query(
    `INSERT INTO content_release_pointers(pointer_key,content_release_id)
     VALUES ('ACTIVE',$1)`,
    [releaseId],
  );

  await client.query(
    `INSERT INTO community_groups(id,provider,chat_ref,role,display_name)
     VALUES ($1,'baileys',$2,'GAME','Headless PVE UAT')`,
    [groupId, CHAT],
  );
  await client.query(
    `INSERT INTO community_group_capabilities(group_id,capability_key)
     VALUES ($1,'player.basic'),($1,'world'),($1,'pve')`,
    [groupId],
  );

  await client.query(
    `INSERT INTO admin_principals(id,identity_ref,status)
     VALUES ($1,$2,'ACTIVE')`,
    [narratorPrincipalId, `whatsapp:${NARRATOR}`],
  );
  await client.query(
    `INSERT INTO admin_roles(id,slug,name)
     VALUES ($1,'HEADLESS_NARRATOR','Headless Narrator')`,
    [roleId],
  );
  await client.query(
    `INSERT INTO capabilities(id,key,risk_tier)
     VALUES ($1,'encounter.support',1)`,
    [capabilityId],
  );
  await client.query(
    `INSERT INTO admin_principal_roles(principal_id,role_id)
     VALUES ($1,$2)`,
    [narratorPrincipalId, roleId],
  );
  await client.query(
    `INSERT INTO admin_role_capabilities(role_id,capability_id)
     VALUES ($1,$2)`,
    [roleId, capabilityId],
  );

  return { releaseId, areaId, yun, itemId, currencyId, narratorPrincipalId };
}

function rawInbound(input: {
  readonly id: string;
  readonly sender: string;
  readonly text: string;
  readonly mentions?: readonly string[];
}) {
  return {
    key: {
      id: input.id,
      remoteJid: CHAT,
      participant: input.sender,
      fromMe: false,
    },
    messageTimestamp: 1_789_000_000,
    message: {
      extendedTextMessage: {
        text: input.text,
        contextInfo: {
          mentionedJid: [...(input.mentions ?? [])],
        },
      },
    },
  };
}

describe.sequential("headless narrator -> multi-spawn -> PVE -> capture/flee UAT", () => {
  const dbName = `bell_headless_pve_${process.pid}_${Date.now()}`;
  const rng = {
    encryptionKey: Buffer.alloc(32, 0x4c),
    encryptionKeyVersion: 1,
  };
  const pveConfig = {
    turnWindowTtlMs: 60_000,
    maintenanceBatchSize: 8,
    encryptionKeys: new Map([[1, rng.encryptionKey]]),
  };

  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;
  let playerId: string;
  const delivered: PendingOutboxMessage[] = [];

  const adapter: OutboundMessageAdapter = {
    channel: "whatsapp",
    async send(message) {
      delivered.push(message);
      return { providerExternalMessageId: `fake:${message.id}` };
    },
  };

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 12 });
    await runMigrations(pool, { appliedBy: "headless-pve-uat" });
    await pool.query(
      await readFile(
        new URL("../../db/candidates/0080_solo_exploration_v4.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/candidates/0081_combat_scene_gate.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/candidates/0082_pvp_group_timing.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/candidates/0083_expedition_reports.sql", import.meta.url),
        "utf8",
      ),
    );

    await pool.query(
      await readFile(
        new URL("../../db/candidates/0084_expedition_search_targets.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/candidates/0085_expedition_world_service_admission.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/candidates/0086_expedition_fishing_encounters.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/candidates/0087_mart_trade_receipts.sql", import.meta.url),
        "utf8",
      ),
    );
    const client = await pool.connect();
    try {
      fixture = await seedFixture(client);
    } finally {
      client.release();
    }

    const onboardingRepository = new PostgresPlayerOnboardingRepository(pool);
    const players = new PlayerRegistrationService(onboardingRepository);
    const bootstrap = new UatBootstrapService(
      pool,
      players,
      new PlayerStarterService(onboardingRepository, new SystemClock(), new CryptoRandomSource()),
      new WorldService(new PostgresWorldRepository(pool), {
        enabled: true,
        reason: null,
      }),
    );

    const prepared = await bootstrap.bootstrap(
      { provider: "baileys", externalId: PLAYER },
      fixture.narratorPrincipalId,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw prepared.error;
    playerId = prepared.value.playerId;

    await pool.query(
      `INSERT INTO inventory_balances(player_id,item_id,quantity)
       VALUES ($1,$2,5)`,
      [playerId, fixture.itemId],
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [dbName],
      );
      if (process.env.V4_REHEARSAL_CLONE_NAME !== undefined) {
        if (process.env.V4_REHEARSAL_CLONE_NAME !== "beyond_v4_candidate")
          throw Error("Unexpected rehearsal clone name");
        await adminPool.query(`CREATE DATABASE beyond_v4_candidate TEMPLATE "${dbName}"`);
      }
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminPool.end();
    }
  }, 120_000);

  function runtime(combatScenesEnabled = false) {
    const composition = createOperationalMessagingComposition(
      pool,
      rng,
      null,
      pveConfig,
      null,
      null,
      null,
      false,
      null,
      false,
      false,
      false,
      combatScenesEnabled,
    );
    const repository = new PostgresMessagingRepository(pool);
    return {
      messaging: new MessagingService(repository, composition.router),
      worker: new OutboxWorker(repository, [adapter], {
        batchSize: 50,
        staleAfterMs: 30_000,
        maxAttempts: 3,
        baseBackoffMs: 1,
        maxBackoffMs: 10,
      }),
    };
  }

  it("proves normalized ingress, durable outbox, replay, restart, partial capture and terminal flee without a real WhatsApp socket", async () => {
    let activeRuntime = runtime();

    const spawn = normalizeBaileysMessage(
      rawInbound({
        id: "wamid-headless-spawn",
        sender: NARRATOR,
        text: "/spawn @treinador 2",
        mentions: [PLAYER_LID],
      }) as never,
      aliases,
    );
    expect(spawn).not.toBeNull();
    if (spawn === null) return;
    expect(spawn.mentions).toEqual([PLAYER]);

    const spawned = await activeRuntime.messaging.receive(spawn);
    expect(spawned).toMatchObject({ ok: true, value: { status: "PROCESSED" } });
    expect(await activeRuntime.worker.runOnce()).toMatchObject({ failed: 0, sent: 1 });

    const encounter = (
      await pool.query<{ id: string; status: string }>(
        `SELECT id,status
           FROM encounters
           WHERE player_id=$1
           ORDER BY created_at DESC
           LIMIT 1`,
        [playerId],
      )
    ).rows[0];
    expect(encounter).toMatchObject({ id: expect.any(String) });

    const wildsAfterSpawn = await pool.query<{ wild_no: number; status: string }>(
      `SELECT wild_no,status
         FROM encounter_wild_snapshots
         WHERE encounter_id=$1
         ORDER BY wild_no`,
      [encounter?.id],
    );
    expect(wildsAfterSpawn.rows).toEqual([
      { wild_no: 1, status: "ACTIVE" },
      { wild_no: 2, status: "ACTIVE" },
    ]);

    const afterFirstSpawnDelivery = delivered.length;
    const spawnReplay = await activeRuntime.messaging.receive(spawn);
    expect(spawnReplay).toMatchObject({ ok: true, value: { status: "REPLAYED" } });
    expect(await activeRuntime.worker.runOnce()).toMatchObject({ failed: 0, sent: 0 });
    expect(delivered).toHaveLength(afterFirstSpawnDelivery);
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM encounters WHERE player_id=$1",
          [playerId],
        )
      ).rows[0]?.count,
    ).toBe("1");

    const start = normalizeBaileysMessage(
      rawInbound({
        id: "wamid-headless-start",
        sender: NARRATOR,
        text: "/iniciarbatalha @treinador",
        mentions: [PLAYER_LID],
      }) as never,
      aliases,
    );
    expect(start).not.toBeNull();
    if (start === null) return;

    expect(await activeRuntime.messaging.receive(start)).toMatchObject({
      ok: true,
      value: { status: "PROCESSED" },
    });
    expect(await activeRuntime.worker.runOnce()).toMatchObject({ failed: 0, sent: 1 });

    const battle = (
      await pool.query<{ id: string; status: string; version: string }>(
        `SELECT id,status,version::text
           FROM battles
           WHERE encounter_id=$1
           ORDER BY created_at DESC
           LIMIT 1`,
        [encounter?.id],
      )
    ).rows[0];
    expect(battle).toMatchObject({ status: "ACTIVE" });

    const initialState = (
      await pool.query<{ state: { combatants?: readonly { participantKind?: string }[] } }>(
        `SELECT state
           FROM battle_state_snapshots
           WHERE battle_id=$1
           ORDER BY version DESC
           LIMIT 1`,
        [battle?.id],
      )
    ).rows[0]?.state;
    expect(
      initialState?.combatants?.filter((entry) => entry.participantKind === "WILD_POKEMON"),
    ).toHaveLength(2);

    const capture = normalizeBaileysMessage(
      rawInbound({
        id: "wamid-headless-capture",
        sender: PLAYER_LID,
        text: "/capturar Poké Ball",
      }) as never,
      aliases,
    );
    expect(capture).not.toBeNull();
    if (capture === null) return;
    expect(capture.senderRef).toBe(PLAYER);

    expect(await activeRuntime.messaging.receive(capture)).toMatchObject({
      ok: true,
      value: { status: "PROCESSED" },
    });
    expect(await activeRuntime.worker.runOnce()).toMatchObject({ failed: 0, sent: 2 });

    const attempts = await pool.query<{
      status: string;
      target_wild_no: number;
    }>(
      `SELECT status,target_wild_no
         FROM capture_attempts
         WHERE encounter_id=$1
         ORDER BY created_at`,
      [encounter?.id],
    );
    if (attempts.rows.length === 0) {
      const ballRows = await pool.query(
        `SELECT balance.quantity::text AS quantity,
                  revision.display_name,
                  revision.item_kind,
                  revision.effect_key
           FROM inventory_balances balance
           LEFT JOIN item_revisions revision
             ON revision.item_id = balance.item_id
            AND revision.content_release_id = $2
           WHERE balance.player_id = $1`,
        [playerId, fixture.releaseId],
      );
      const encounterState = await pool.query(
        "SELECT status,revision::text FROM encounters WHERE id=$1",
        [encounter?.id],
      );
      const battleState = await pool.query("SELECT status,version::text FROM battles WHERE id=$1", [
        battle?.id,
      ]);
      const lastTexts = delivered
        .slice(-3)
        .map((message) => message.payload.text)
        .filter((value): value is string => typeof value === "string");
      throw new Error(
        "HEADLESS_CAPTURE_DIAGNOSTIC " +
          JSON.stringify({
            lastTexts,
            balls: ballRows.rows,
            encounter: encounterState.rows,
            battle: battleState.rows,
          }),
      );
    }
    expect(attempts.rows).toEqual([{ status: "CAPTURED", target_wild_no: 1 }]);

    const wildsAfterCapture = await pool.query<{ wild_no: number; status: string }>(
      `SELECT wild_no,status
         FROM encounter_wild_snapshots
         WHERE encounter_id=$1
         ORDER BY wild_no`,
      [encounter?.id],
    );
    expect(wildsAfterCapture.rows).toEqual([
      { wild_no: 1, status: "CAPTURED" },
      { wild_no: 2, status: "ACTIVE" },
    ]);
    expect(
      (await pool.query<{ status: string }>("SELECT status FROM battles WHERE id=$1", [battle?.id]))
        .rows[0]?.status,
    ).toBe("ACTIVE");
    expect(
      (
        await pool.query<{ status: string }>("SELECT status FROM encounters WHERE id=$1", [
          encounter?.id,
        ])
      ).rows[0]?.status,
    ).toBe("IN_BATTLE");

    // Logical process recreation: same PostgreSQL state, new router/service/repository instances.
    activeRuntime = runtime();

    const flee = normalizeBaileysMessage(
      rawInbound({
        id: "wamid-headless-flee",
        sender: PLAYER_LID,
        text: "/fugir",
      }) as never,
      aliases,
    );
    expect(flee).not.toBeNull();
    if (flee === null) return;

    expect(await activeRuntime.messaging.receive(flee)).toMatchObject({
      ok: true,
      value: { status: "PROCESSED" },
    });
    expect(await activeRuntime.worker.runOnce()).toMatchObject({ failed: 0, sent: 2 });

    expect(
      (await pool.query<{ status: string }>("SELECT status FROM battles WHERE id=$1", [battle?.id]))
        .rows[0]?.status,
    ).toBe("FLED");
    expect(
      (
        await pool.query<{ status: string }>("SELECT status FROM encounters WHERE id=$1", [
          encounter?.id,
        ])
      ).rows[0]?.status,
    ).toBe("FLED");

    const remainingActive = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM encounters
         WHERE player_id=$1
           AND status IN ('CREATED','PRESENTED','ENGAGED','CAPTURE_RESOLVING','IN_BATTLE')`,
      [playerId],
    );
    expect(remainingActive.rows[0]?.count).toBe("0");

    const texts = delivered
      .map((message) => message.payload.text)
      .filter((value): value is string => typeof value === "string");
    expect(
      texts.some((text) => text.includes("𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢 𝗦𝗘𝗟𝗩𝗔𝗚𝗘𝗠") && text.includes("· Grupo")),
    ).toBe(true);
    expect(texts.some((text) => text.includes("✦ *𝗕𝗔𝗧𝗔𝗟𝗛𝗔*"))).toBe(true);
    expect(texts.some((text) => text.includes("capturado."))).toBe(true);
    expect(texts.every((text) => !UUID_IN_TEXT.test(text))).toBe(true);

    const outbox = await pool.query<{ status: string; count: string }>(
      `SELECT status,count(*)::text AS count
         FROM outbox_messages
         GROUP BY status
         ORDER BY status`,
    );
    expect(outbox.rows).toEqual([
      { status: "PENDING", count: "1" },
      { status: "SENT", count: "6" },
    ]);
  }, 60_000);
  it("gates a real capture and recovers a commit/answer crash without conflicting with the pending-choice Outbox", async () => {
    let active = runtime(true);
    const transcript: string[] = [];
    const startDelivery = delivered.length;
    const send = async (id: string, sender: string, text: string) => {
      const deliveryOffset = delivered.length;
      transcript.push("JOGADOR → " + text);
      const incoming = normalizeBaileysMessage(
        rawInbound({
          id,
          sender,
          text,
          mentions: sender === NARRATOR ? [PLAYER_LID] : [],
        }) as never,
        aliases,
      );
      if (!incoming) throw new Error("invalid synthetic input");
      const result = await active.messaging.receive(incoming);
      await active.worker.runOnce();
      for (const message of delivered.slice(deliveryOffset)) {
        if (typeof message.payload.text === "string")
          transcript.push("BOT → " + String(message.payload.text));
      }
      return { incoming, result };
    };
    const before = await pool.query(
      "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",
      [playerId, fixture.itemId],
    );
    await send("scene-spawn", NARRATOR, "/spawn @treinador");
    const attemptBefore = (await pool.query("SELECT count(*)::int AS n FROM capture_attempts"))
      .rows[0].n;
    const action = await send("scene-capture-choice", PLAYER_LID, "/capturar Poké Ball");
    expect(action.result).toMatchObject({ ok: true, value: { status: "PROCESSED" } });
    expect((await pool.query("SELECT count(*)::int AS n FROM capture_attempts")).rows[0].n).toBe(
      attemptBefore,
    );
    expect(
      (
        await pool.query(
          "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",
          [playerId, fixture.itemId],
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM combat_scene_gates WHERE record->'action' IS NOT NULL",
        )
      ).rows[0].n,
    ).toBe(1);
    active = runtime(true);
    const words =
      "Ao perceber o movimento entre as folhas seguro minha mochila e observo com cuidado o terreno ao redor do pequeno Pokémon Respiro devagar enquanto escolho uma posição segura perto das árvores Minha companheira permanece ao lado esperando meu sinal Preparo o lançamento com atenção respeitando a distância e a reação do selvagem antes de mover os braços e soltar a esfera".split(
        " ",
      );
    const short = await send("scene-short", PLAYER_LID, "/cena " + words.slice(0, 49).join(" "));
    expect(short.result.ok).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM capture_attempts")).rows[0].n).toBe(
      attemptBefore,
    );
    const originalAttempt = CaptureService.prototype.attempt;
    const fault = vi.spyOn(CaptureService.prototype, "attempt").mockImplementation(async function (
      this: CaptureService,
      input,
    ) {
      const committed = await originalAttempt.call(this, input);
      if (committed.ok && input.idempotencyKey === "inbox:baileys:scene-capture-choice")
        throw new Error("Injected crash after canonical capture commit");
      return committed;
    });
    const scene = await send("scene-valid", PLAYER_LID, "/cena " + words.slice(0, 50).join(" "));
    fault.mockRestore();
    expect(scene.result).toMatchObject({ ok: false });
    active = runtime(true);
    transcript.push("RECUPERAÇÃO → reinício e retransmissão da mesma Cena, com o mesmo ID");
    const recoveryDeliveryOffset = delivered.length;
    expect(await active.messaging.receive(scene.incoming)).toMatchObject({
      ok: true,
      value: { status: "PROCESSED" },
    });
    await active.worker.runOnce();
    const recoveryMessages = delivered
      .slice(recoveryDeliveryOffset)
      .filter((message) => typeof message.payload.text === "string");
    expect(recoveryMessages).toHaveLength(1);
    expect(recoveryMessages[0]?.idempotencyKey).toBe(
      "inbox:baileys:scene-capture-choice:combat-scene:recovered",
    );
    expect(recoveryMessages[0]?.destinationRef).toBe(PLAYER);
    for (const message of recoveryMessages) transcript.push("BOT (PV) → " + message.payload.text);
    expect((await pool.query("SELECT count(*)::int AS n FROM capture_attempts")).rows[0].n).toBe(
      attemptBefore + 1,
    );
    expect(
      (
        await pool.query(
          "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",
          [playerId, fixture.itemId],
        )
      ).rows,
    ).toEqual([{ quantity: String(Number(before.rows[0].quantity) - 1) }]);
    active = runtime(true);
    expect(await active.messaging.receive(scene.incoming)).toMatchObject({
      ok: true,
      value: { status: "REPLAYED" },
    });
    expect((await pool.query("SELECT count(*)::int AS n FROM capture_attempts")).rows[0].n).toBe(
      attemptBefore + 1,
    );
    const texts = delivered.slice(startDelivery).filter((m) => typeof m.payload.text === "string");
    expect(texts.some((m) => String(m.payload.text).includes("𝗖𝗘𝗡𝗔 𝗣𝗘𝗡𝗗𝗘𝗡𝗧𝗘"))).toBe(true);
    expect(texts.some((m) => String(m.payload.text).includes("49/50"))).toBe(true);
    expect(texts.every((m) => !UUID_IN_TEXT.test(String(m.payload.text)))).toBe(true);
    if (process.env.SCENE_TRANSCRIPT_FILE)
      await writeFile(process.env.SCENE_TRANSCRIPT_FILE, transcript.join("\n\n"));
  }, 120_000);
  it("joins two private PvP actions with public Scenes without quoting either choice into the group", async () => {
    const transcript: string[] = [];
    const turnResults: unknown[] = [];
    const originalResolve = BattleService.prototype.resolvePlayerTurn;
    const turnSpy = vi
      .spyOn(BattleService.prototype, "resolvePlayerTurn")
      .mockImplementation(async function (this: BattleService, input) {
        const result = await originalResolve.call(this, input);
        turnResults.push(result);
        return result;
      });
    const opponent = "5511999990003@s.whatsapp.net";
    const onboarding = new PostgresPlayerOnboardingRepository(pool);
    const bootstrap = new UatBootstrapService(
      pool,
      new PlayerRegistrationService(onboarding),
      new PlayerStarterService(onboarding, new SystemClock(), new CryptoRandomSource()),
      new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null }),
    );
    const prepared = await bootstrap.bootstrap(
      { provider: "baileys", externalId: opponent },
      fixture.narratorPrincipalId,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw prepared.error;
    await pool.query(
      "INSERT INTO community_group_capabilities(group_id,capability_key) SELECT id,'pvp' FROM community_groups WHERE provider='baileys' AND chat_ref=$1 ON CONFLICT DO NOTHING",
      [CHAT],
    );
    let active = runtime(true);
    const send = async (
      id: string,
      sender: string,
      text: string,
      privateChat = false,
      mentions: readonly string[] = [],
    ) => {
      const deliveryOffset = delivered.length;
      transcript.push((privateChat ? "JOGADOR (PV) → " : "GRUPO → ") + text);
      const raw = rawInbound({ id, sender, text, mentions });
      if (privateChat) raw.key.remoteJid = sender;
      const incoming = normalizeBaileysMessage(raw as never, aliases);
      if (!incoming) throw Error("bad input");
      const result = await active.messaging.receive(incoming);
      await active.worker.runOnce();
      for (const message of delivered.slice(deliveryOffset)) {
        if (typeof message.payload.text === "string")
          transcript.push(
            (message.destinationRef === CHAT ? "BOT (GRUPO) → " : "BOT (PV) → ") +
              message.payload.text,
          );
      }
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        value: { status: "PROCESSED" },
      });
      return incoming;
    };
    await send("scene-pvp-challenge", PLAYER, "/desafiar @rival", false, [opponent]);
    await send("scene-pvp-accept", opponent, "/aceitar");
    const battle = (
      await pool.query(
        "SELECT battle_id FROM pvp_challenges WHERE challenger_player_id=$1 AND target_player_id=$2 ORDER BY created_at DESC LIMIT 1",
        [playerId, prepared.value.playerId],
      )
    ).rows[0].battle_id;
    const snapshot = async () =>
      (
        await pool.query(
          "SELECT version::text,state FROM battle_state_snapshots WHERE battle_id=$1 ORDER BY version DESC LIMIT 1",
          [battle],
        )
      ).rows[0];
    const before = await snapshot();
    const windows = async () =>
      (
        await pool.query(
          "SELECT battle_version,extract(epoch FROM deadline_at-opened_at)::int AS seconds,deadline_at FROM battle_turn_windows WHERE battle_id=$1 ORDER BY battle_version",
          [battle],
        )
      ).rows;
    const firstWindow = await windows();
    expect(firstWindow[0].seconds).toBe(43200);
    await send("pvp-timing-denied", NARRATOR, "/pvp prazo 3");
    expect((await pool.query("SELECT count(*)::int AS n FROM pvp_group_timing")).rows[0].n).toBe(0);
    await pool.query(
      "INSERT INTO capabilities(id,key,risk_tier) VALUES($1,'community.group.manage',3)",
      [randomUUID()],
    );
    await pool.query(
      "INSERT INTO admin_role_capabilities(role_id,capability_id) SELECT r.id,c.id FROM admin_roles r CROSS JOIN capabilities c WHERE r.slug='HEADLESS_NARRATOR' AND c.key='community.group.manage'",
    );
    await pool.query(
      "INSERT INTO admin_principal_scopes(id,principal_id,scope_type,scope_id) VALUES($1,$2,'GLOBAL',NULL)",
      [randomUUID(), fixture.narratorPrincipalId],
    );
    await send("pvp-timing-two-hours", NARRATOR, "/pvp prazo 2");
    expect(await windows()).toEqual(firstWindow);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='community.group.pvp_timing'",
        )
      ).rows[0].n,
    ).toBe(1);
    const pvpDeliveryOffset = delivered.length;
    const publicBefore = delivered.filter(
      (m) => m.destinationRef === CHAT && typeof m.payload.text === "string",
    ).length;
    await send("scene-pvp-a-private", PLAYER, "/movimento 1", true);
    expect(await snapshot()).toEqual(before);
    expect(
      delivered.filter((m) => m.destinationRef === CHAT && typeof m.payload.text === "string"),
    ).toHaveLength(publicBefore);
    const narrative = Array.from({ length: 50 }, () => "caminho").join(" ");
    await send("scene-pvp-a-scene", PLAYER, "/cena " + narrative);
    expect(await snapshot()).toEqual(before);
    active = runtime(true);
    await send("scene-pvp-b-scene", opponent, "/cena " + narrative);
    expect(await snapshot()).toEqual(before);
    const last = await send("scene-pvp-b-private", opponent, "/movimento 1", true);
    const after = await snapshot();
    turnSpy.mockRestore();
    expect(Number(after.version), JSON.stringify(turnResults)).toBe(Number(before.version) + 1);
    expect((await windows()).map((window) => window.seconds)).toEqual([43200, 7200]);
    expect((await windows())[0].deadline_at).toEqual(firstWindow[0].deadline_at);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM battle_turn_submissions s JOIN battle_turn_windows w ON w.id=s.turn_window_id WHERE w.battle_id=$1 AND w.battle_version=$2",
          [battle, Number(before.version)],
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
    const resolutions = delivered
      .slice(pvpDeliveryOffset)
      .filter((m) => m.destinationRef === CHAT && m.payload.combatResolution === true);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.payload.replyToText).toBeUndefined();
    expect(resolutions[0]?.payload.replyToExternalMessageId).toBeUndefined();
    expect(JSON.stringify(resolutions)).not.toContain("/movimento 1");
    const publicCount = delivered.filter((m) => m.destinationRef === CHAT).length;
    expect(await runtime(true).messaging.receive(last)).toMatchObject({
      ok: true,
      value: { status: "REPLAYED" },
    });
    expect(delivered.filter((m) => m.destinationRef === CHAT)).toHaveLength(publicCount);
    expect(await snapshot()).toEqual(after);
    await send("scene-pvp-surrender", PLAYER, "/desistir");
    await send("scene-pvp-next-challenge", PLAYER, "/desafiar @rival", false, [opponent]);
    await send("scene-pvp-next-accept", opponent, "/aceitar");
    const nextWindow = await pool.query(
      "SELECT extract(epoch FROM w.deadline_at-w.opened_at)::int AS seconds FROM pvp_challenges c JOIN battle_turn_windows w ON w.battle_id=c.battle_id WHERE c.challenger_player_id=$1 AND c.target_player_id=$2 AND c.battle_id<>$3",
      [playerId, prepared.value.playerId, battle],
    );
    expect(nextWindow.rows).toEqual([{ seconds: 7200 }]);
    if (process.env.SCENE_TRANSCRIPT_FILE)
      await writeFile(process.env.SCENE_TRANSCRIPT_FILE + ".pvp.txt", transcript.join("\n\n"));
  }, 120000);
  it("plays operational V4 from an existing trainer through transport, quoted capture, restart, resources and factual closure", async () => {
    const createSeed = AesEncounterSeedProvider.prototype.create;
    const deterministic = new AesEncounterSeedProvider(rng.encryptionKey, 1, () =>
      Buffer.alloc(32),
    );
    const seeded = vi
      .spyOn(AesEncounterSeedProvider.prototype, "create")
      .mockImplementation((context) => createSeed.call(deterministic, context));
    const external = "5511999990004@s.whatsapp.net";
    const onboarding = new PostgresPlayerOnboardingRepository(pool);
    const prepared = await new UatBootstrapService(
      pool,
      new PlayerRegistrationService(onboarding),
      new PlayerStarterService(onboarding, new SystemClock(), new CryptoRandomSource()),
      new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null }),
    ).bootstrap({ provider: "baileys", externalId: external }, fixture.narratorPrincipalId);
    if (!prepared.ok) throw prepared.error;
    const oldPlayer = prepared.value.playerId;
    await pool.query(
      "INSERT INTO trainer_unlocks(player_id,unlock_key,source_type,source_id) VALUES($1,'proof.blackout.lock','FIXTURE','v4')",
      [oldPlayer],
    );
    // An existing NORMAL approved account, with mechanical state bootstrapped
    // only as fixture setup. Preserve its real review/access invariants.
    const approvedReview = randomUUID();
    await pool.query(
      "INSERT INTO registration_revisions(id,player_id,sequence_no,status,schema_version,snapshot_json,revision,decided_by_admin_principal_id,decided_at) VALUES($1,$2,1,'APPROVED',1,'{}'::jsonb,1,$3,now())",
      [approvedReview, oldPlayer, fixture.narratorPrincipalId],
    );
    await pool.query(
      "UPDATE player_access SET access_origin='NORMAL',approved_review_id=$2 WHERE player_id=$1",
      [oldPlayer, approvedReview],
    );
    const parsedPlayer = parsePlayerId(oldPlayer);
    if (!parsedPlayer.ok) throw parsedPlayer.error;
    const access = new PostgresPlayerAccessRepository(pool);
    await pool.query("INSERT INTO inventory_balances(player_id,item_id,quantity) VALUES($1,$2,3)", [
      oldPlayer,
      fixture.itemId,
    ]);
    await pool.query(
      "INSERT INTO solo_expeditions(id,player_id,period,area_id,phase,elapsed_minutes,consumed_week_key,end_reason) SELECT gen_random_uuid(),$1,'DAY',$2,'ENDED',30,date_trunc('week',now() AT TIME ZONE 'America/Sao_Paulo')::date,'VOLUNTARY' FROM generate_series(1,3)",
      [oldPlayer, fixture.areaId],
    );
    const pokemonBefore = (
      await pool.query(
        "SELECT p.id,p.xp::text,p.current_hp FROM pokemon_instances p WHERE owner_player_id=$1 ORDER BY id",
        [oldPlayer],
      )
    ).rows;
    const bootstrapAccount = new UatBootstrapService(
      pool,
      new PlayerRegistrationService(onboarding),
      new PlayerStarterService(onboarding, new SystemClock(), new CryptoRandomSource()),
      new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null }),
    );
    const allowed = new Set([parsedPlayer.value]);
    for (const externalId of [
      NARRATOR,
      "5511999990005@s.whatsapp.net",
      "5511999990006@s.whatsapp.net",
    ]) {
      const account = await bootstrapAccount.bootstrap(
        { provider: "baileys", externalId },
        fixture.narratorPrincipalId,
      );
      if (!account.ok) throw account.error;
      const id = parsePlayerId(account.value.playerId);
      if (!id.ok) throw id.error;
      allowed.add(id.value);
    }
    const create = () =>
      createOperationalSimulatedWhatsAppRuntime({
        pool,
        encounterRngConfig: rng,
        pveBattleConfig: pveConfig,
        fishingDayTimeZone: "America/Sao_Paulo",
        explorationReadMoreCombiningCount: 450,
        operationalExpeditionPreview: {
          allowedPlayerIds: allowed,
          timeZone: "America/Sao_Paulo",
          playSecret: Buffer.alloc(32, 0x72),
        },
      });
    let active = create();
    await active.runtime.start();
    const transcript: unknown[] = [];
    const flush = async () => {
      await active.runtime.flushOutbox();
      await active.runtime.flushOutbox();
      expect(active.expeditionPostSentFailures).toEqual([]);
    };
    const send = async (
      text: string,
      id: string = randomUUID(),
      quote: string | null = null,
      chat = CHAT,
      sender = external,
      mentions: readonly string[] = [],
    ) => {
      // Exercise the real limiter: these are successive player decisions, not
      // an artificial burst exceeding five sensitive commands per 10 seconds.
      if (text.startsWith("/")) await new Promise((resolve) => setTimeout(resolve, 2200));
      const input = await active.adapter.injectText({
        senderRef: sender,
        mentions,
        chatRef: chat,
        text,
        externalMessageId: id,
        replyToExternalMessageId: quote,
      });
      await flush();
      return input;
    };
    try {
      await send("/explorar");
      expect(active.adapter.sent.at(-1)?.payload.text).toContain("3/6");
      const openingQuote = active.adapter.sent.at(-1)!.id.replaceAll("-", "").toUpperCase();
      await send("1", randomUUID(), openingQuote, external);
      const preparationPanel = active.adapter.sent.at(-1)!;
      expect(preparationPanel.payload.text).toContain("\u031d".repeat(450));
      await send("2", randomUUID(), openingQuote, external);
      expect(active.adapter.sent.at(-1)?.payload.text).toContain("estado mudou");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key IS NOT NULL",
            [oldPlayer],
          )
        ).rows[0].n,
      ).toBe(3);
      const beforeTarget = (
        await pool.query(
          "SELECT to_jsonb(e) AS state FROM solo_expeditions e WHERE player_id=$1 AND phase='PREPARING'",
          [oldPlayer],
        )
      ).rows;
      await send("/explorar buscar especie-nao-conhecida");
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(e) AS state FROM solo_expeditions e WHERE player_id=$1 AND phase='PREPARING'",
            [oldPlayer],
          )
        ).rows,
      ).toEqual(beforeTarget);
      await pool.query(
        `INSERT INTO player_pokedex_species(player_id,species_id,seen_count,caught_count,first_seen_at,last_seen_at)
        SELECT $1,id,1,0,now(),now() FROM pokemon_species WHERE slug='uat-bellsprout'
        ON CONFLICT(player_id,species_id) DO NOTHING`,
        [oldPlayer],
      );
      const failure = vi
        .spyOn(PostgresMessagingRepository.prototype, "completeIncoming")
        .mockImplementationOnce(async () => {
          throw new Error("fixture crash after search commit");
        });
      const search = await send("/explorar buscar uat-bellsprout");
      failure.mockRestore();
      expect(
        (
          await pool.query("SELECT status FROM inbox_messages WHERE external_message_id=$1", [
            search.externalMessageId,
          ])
        ).rows,
      ).toEqual([{ status: "FAILED" }]);
      await active.runtime.stop();
      active = create();
      await active.runtime.start();
      await active.adapter.inject(search);
      await flush();
      expect(
        (
          await pool.query("SELECT status FROM inbox_messages WHERE external_message_id=$1", [
            search.externalMessageId,
          ])
        ).rows,
      ).toEqual([{ status: "PROCESSED" }]);
      expect(
        (
          await pool.query(
            `SELECT target.species_slug FROM solo_expedition_search_targets target
        JOIN solo_expedition_search_outcomes outcome ON outcome.id=target.outcome_id WHERE outcome.player_id=$1`,
            [oldPlayer],
          )
        ).rows,
      ).toEqual([{ species_slug: "uat-bellsprout" }]);
      const menu = active.adapter.sent.find((out) => out.payload.expeditionMenu !== undefined);
      expect(menu).toBeDefined();
      if (!menu) throw Error("No actionable V4 menu delivered");
      expect(menu.payload.text).toContain("2. ◉ Poké Ball");
      expect(menu.payload.text).toContain("\u031d".repeat(450));
      const quote = menu.id.replaceAll("-", "").toUpperCase();
      const attempts = () =>
        pool.query("SELECT count(*)::int AS n FROM capture_attempts WHERE player_id=$1", [
          oldPlayer,
        ]);
      const originalWindow = (
        await pool.query(
          "SELECT id,created_at,expires_at FROM encounters WHERE player_id=$1 AND status='ENGAGED'",
          [oldPlayer],
        )
      ).rows[0];
      await pool.query(
        "UPDATE encounters SET created_at=now()-interval '1 minute',expires_at=now()-interval '1 second' WHERE id=$1",
        [originalWindow.id],
      );
      try {
        await send("2", "v4-expired-ball-menu", quote, external);
        expect(active.adapter.sent.at(-1)?.payload.text).toContain("bloqueada");
        expect((await attempts()).rows[0].n).toBe(0);
      } finally {
        await pool.query("UPDATE encounters SET created_at=$2,expires_at=$3 WHERE id=$1", [
          originalWindow.id,
          originalWindow.created_at,
          originalWindow.expires_at,
        ]);
      }
      const choice = await send("2", "v4-ball-choice", quote, external);
      expect((await attempts()).rows[0].n).toBe(0);
      transcript.push(...active.adapter.transcript);
      await active.runtime.stop();
      active = create();
      await active.runtime.start();
      await active.adapter.inject(choice);
      await flush();
      expect((await attempts()).rows[0].n).toBe(0);
      const scene = await send(
        "/cena " + Array.from({ length: 50 }, () => "árvore").join(" "),
        "v4-scene",
        null,
        external,
      );
      expect((await attempts()).rows[0].n).toBe(1);
      await active.adapter.inject(scene);
      await active.adapter.inject(search);
      await flush();
      expect((await attempts()).rows[0].n).toBe(1);
      const encounter = (
        await pool.query(
          "SELECT id,status FROM encounters WHERE player_id=$1 ORDER BY created_at DESC LIMIT 1",
          [oldPlayer],
        )
      ).rows[0];
      if (encounter.status !== "CAPTURED") {
        // A failed canonical capture remains a live encounter. The V4 ignore
        // choice is reissued by its canonical menu lifecycle, never forced here.
        throw Error("Synthetic capture fixture must resolve before closure: " + encounter.status);
      }
      await send("/onde");
      expect(String(active.adapter.sent.at(-1)?.payload.text)).toContain("Vila dos Arrozais");
      await send("/centropokemon");
      const session = (
        await pool.query(
          "SELECT id,scene_proof_id FROM world_service_sessions WHERE player_id=$1 AND state='OPEN'",
          [oldPlayer],
        )
      ).rows[0];
      expect(session).toBeDefined();
      expect(session.scene_proof_id).toBeNull();
      const healing = await send("/curar", "v4-world-healing");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM pokemon_center_healing_claims WHERE player_id=$1",
            [oldPlayer],
          )
        ).rows[0].n,
      ).toBe(1);
      const afterHealing = (
        await pool.query(
          "SELECT elapsed_minutes FROM solo_expeditions WHERE player_id=$1 AND phase='ACTIVE'",
          [oldPlayer],
        )
      ).rows;
      expect(afterHealing).toEqual([{ elapsed_minutes: 60 }]);
      await active.runtime.stop();
      active = create();
      await active.runtime.start();
      await active.adapter.inject(healing);
      await flush();
      expect(
        (
          await pool.query(
            "SELECT elapsed_minutes FROM solo_expeditions WHERE player_id=$1 AND phase='ACTIVE'",
            [oldPlayer],
          )
        ).rows,
      ).toEqual(afterHealing);
      await send("/pc");
      expect(String(active.adapter.sent.at(-1)?.payload.text)).toContain("/caixas");
      await send("/sair");
      await send("/sair"); // PC -> Center -> outside, preserving the original hierarchy.
      await send("/pokemart");
      expect(
        (
          await pool.query(
            "SELECT service_kind FROM world_service_sessions WHERE player_id=$1 AND state='OPEN'",
            [oldPlayer],
          )
        ).rows,
      ).toEqual([{ service_kind: "POKEMART" }]);
      await pool.query(
        "INSERT INTO wallet_balances(player_id,currency_id,amount) VALUES($1,$2,100)",
        [oldPlayer, fixture.currencyId],
      );
      await send("/comprar");
      await send("01");
      const purchaseFault = vi
        .spyOn(PostgresMessagingRepository.prototype, "completeIncoming")
        .mockImplementationOnce(async () => {
          throw new Error("fixture crash after purchase commit");
        });
      const purchase = await send("1", "v4-mart-purchase");
      purchaseFault.mockRestore();
      await active.runtime.stop();
      active = create();
      await active.runtime.start();
      await active.adapter.inject(purchase);
      await flush();
      expect(
        (
          await pool.query(
            "SELECT amount::text FROM wallet_balances WHERE player_id=$1 AND currency_id=$2",
            [oldPlayer, fixture.currencyId],
          )
        ).rows,
      ).toEqual([{ amount: "77" }]);
      await send("/vender");
      await send("01");
      const saleFault = vi
        .spyOn(PostgresMessagingRepository.prototype, "completeIncoming")
        .mockImplementationOnce(async () => {
          throw new Error("fixture crash after sale commit");
        });
      const sale = await send("1", "v4-mart-sale");
      saleFault.mockRestore();
      await send("/sair");
      await active.adapter.inject(sale);
      await flush();
      expect(
        (
          await pool.query(
            "SELECT amount::text FROM wallet_balances WHERE player_id=$1 AND currency_id=$2",
            [oldPlayer, fixture.currencyId],
          )
        ).rows,
      ).toEqual([{ amount: "88" }]);
      expect(
        (
          await pool.query(
            "SELECT status FROM inbox_messages WHERE external_message_id IN ('v4-mart-purchase','v4-mart-sale') ORDER BY external_message_id",
          )
        ).rows,
      ).toEqual([{ status: "PROCESSED" }, { status: "PROCESSED" }]);
      expect(
        (
          await pool.query(
            "SELECT kind FROM world_service_mart_trade_receipts WHERE player_id=$1 ORDER BY kind",
            [oldPlayer],
          )
        ).rows,
      ).toEqual([{ kind: "PURCHASE" }, { kind: "SALE" }]);
      const fishRoll = vi.spyOn(CryptoRandomSource.prototype, "randomInt").mockReturnValue(9);
      try {
        const fishing = await send("/pescar", "v4-world-fishing");
        await active.adapter.inject(fishing);
        await flush();
      } finally {
        fishRoll.mockRestore();
      }
      expect(
        (
          await pool.query("SELECT count(*)::int AS n FROM fishing_attempts WHERE player_id=$1", [
            oldPlayer,
          ])
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT elapsed_minutes FROM solo_expeditions WHERE player_id=$1 AND phase='ACTIVE'",
            [oldPlayer],
          )
        ).rows,
      ).toEqual(afterHealing);
      const caughtEncounter = (
        await pool.query(
          "SELECT encounter_id FROM solo_expedition_fishing_encounters WHERE player_id=$1",
          [oldPlayer],
        )
      ).rows[0];
      expect(caughtEncounter).toBeDefined();
      const fishingEncounters = new EncounterService(
        new PostgresEncounterRepository(pool),
        new AesEncounterSeedProvider(rng.encryptionKey, 1, () => Buffer.alloc(32)),
        new SystemClock(),
        { enabled: true, reason: null },
      );
      const fishingPlayer = parsePlayerId(oldPlayer);
      if (!fishingPlayer.ok) throw fishingPlayer.error;
      const fled = await fishingEncounters.flee({
        playerId: fishingPlayer.value,
        encounterId: caughtEncounter.encounter_id,
        expectedRevision: 0n,
      });
      if (!fled.ok) throw fled.error;
      const travel = await send("/explorar viajar campos-de-yun", "v4-travel-out");
      await active.adapter.inject(travel);
      await flush();
      expect(
        (
          await pool.query(
            "SELECT area.slug,e.elapsed_minutes FROM solo_expeditions e JOIN player_locations l ON l.player_id=e.player_id JOIN areas area ON area.id=l.area_id WHERE e.player_id=$1 AND e.phase='ACTIVE'",
            [oldPlayer],
          )
        ).rows,
      ).toEqual([{ slug: "campos-de-yun", elapsed_minutes: 67 }]);
      await send("/explorar viajar vila-dos-arrozais");
      await send("/explorar recursos");
      await send("/explorar encerrar");
      await send("/explorar encerrar confirmar", "v4-end");
      await send("/explorar resumo");
      await send("/explorar eventos");
      expect(
        active.adapter.sent.some((out) => String(out.payload.text).includes("100 palavras")),
        JSON.stringify(active.adapter.sent.map((message) => message.payload.text)),
      ).toBe(true);
      const ended = (
        await pool.query(
          "SELECT phase,elapsed_minutes,end_reason FROM solo_expeditions WHERE player_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [oldPlayer],
        )
      ).rows[0];
      expect(ended).toMatchObject({
        phase: "ENDED",
        elapsed_minutes: 136,
        end_reason: "VOLUNTARY",
      });
      expect(
        (
          await pool.query(
            "SELECT id,xp::text,current_hp FROM pokemon_instances WHERE owner_player_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
            [oldPlayer, pokemonBefore.map((p) => p.id)],
          )
        ).rows,
      ).toEqual(pokemonBefore);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key IS NOT NULL",
            [oldPlayer],
          )
        ).rows[0].n,
      ).toBe(4);
      const reportFailure = vi
        .spyOn(PostgresMessagingRepository.prototype, "completeIncoming")
        .mockRejectedValueOnce(new Error("fixture crash after report submission commit"));
      const submission = await send(
        "/explorar relatorio https://example.invalid/relatorio-sintetico",
        "v4-report",
      );
      reportFailure.mockRestore();
      const newer = randomUUID();
      await pool.query(
        "INSERT INTO solo_expeditions(id,player_id,period,area_id,phase,elapsed_minutes,consumed_week_key,end_reason,created_at) VALUES($1,$2,'DAY',$3,'ENDED',30,'2026-11-02','VOLUNTARY',now()+interval '1 minute')",
        [newer, oldPlayer, fixture.areaId],
      );
      try {
        await active.runtime.stop();
        active = create();
        await active.runtime.start();
        await active.adapter.inject(submission);
        await flush();
        expect(
          active.adapter.sent.some((message) =>
            String(message.payload.text).includes("Referência externa registrada."),
          ),
        ).toBe(true);
        expect(
          (
            await pool.query("SELECT 1 FROM solo_expedition_reports WHERE expedition_id=$1", [
              newer,
            ])
          ).rowCount,
        ).toBe(0);
      } finally {
        await pool.query("DELETE FROM solo_expeditions WHERE id=$1", [newer]);
      }
      const report = (
        await pool.query(
          "SELECT id,status,revision::text FROM solo_expedition_reports WHERE player_id=$1",
          [oldPlayer],
        )
      ).rows[0];
      expect(
        report,
        JSON.stringify(active.adapter.sent.slice(-3).map((message) => message.payload.text)),
      ).toMatchObject({ status: "SUBMITTED", revision: "0" });
      await send(
        "/explorar revisar normal 100 @treinador",
        "v4-review-denied",
        null,
        CHAT,
        PLAYER,
        [external],
      );
      expect(
        (await pool.query("SELECT status FROM solo_expedition_reports WHERE id=$1", [report.id]))
          .rows[0].status,
      ).toBe("SUBMITTED");
      await pool.query(
        "INSERT INTO capabilities(id,key,risk_tier) VALUES($1,'reward.grant',2) ON CONFLICT(key) DO NOTHING",
        [randomUUID()],
      );
      await pool.query(
        "INSERT INTO admin_role_capabilities(role_id,capability_id) SELECT r.id,c.id FROM admin_roles r CROSS JOIN capabilities c WHERE r.slug='HEADLESS_NARRATOR' AND c.key='reward.grant' ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "INSERT INTO admin_principal_scopes(id,principal_id,scope_type,scope_id) SELECT $1,$2,'GLOBAL',NULL WHERE NOT EXISTS(SELECT 1 FROM admin_principal_scopes WHERE principal_id=$2 AND scope_type='GLOBAL' AND status='ACTIVE')",
        [randomUUID(), fixture.narratorPrincipalId],
      );
      await send(
        "/explorar revisar normal 99 @treinador",
        "v4-review-short",
        null,
        CHAT,
        NARRATOR,
        [external],
      );
      expect(
        (await pool.query("SELECT status FROM solo_expedition_reports WHERE id=$1", [report.id]))
          .rows[0].status,
      ).toBe("SUBMITTED");
      const currentAccess = await access.read((tx) => tx.load(parsedPlayer.value));
      const suspended = await access.transaction((tx) =>
        tx.suspend({ playerId: parsedPlayer.value, expectedRevision: currentAccess.revision }),
      );
      expect(suspended?.status).toBe("SUSPENDED");
      await send(
        "/explorar revisar normal 100 @treinador",
        "v4-review-suspended",
        null,
        CHAT,
        NARRATOR,
        [external],
      );
      expect(
        (await pool.query("SELECT status FROM solo_expedition_reports WHERE id=$1", [report.id]))
          .rows[0].status,
      ).toBe("SUBMITTED");
      const restoredAccess = await access.transaction((tx) =>
        tx.restore({ playerId: parsedPlayer.value, expectedRevision: suspended!.revision }),
      );
      expect(restoredAccess?.status).toBe("ACTIVE");
      // The fixture has no progression rules. Highlight preflight must refuse all credits.
      await send(
        "/explorar revisar destaque 100 @treinador | Narrou a captura e o uso da Ball, conferidos no resumo.",
        "v4-review-rollback",
        null,
        CHAT,
        NARRATOR,
        [external],
      );
      expect(
        (await pool.query("SELECT status FROM solo_expedition_reports WHERE id=$1", [report.id]))
          .rows[0].status,
      ).toBe("SUBMITTED");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM inventory_ledger WHERE player_id=$1 AND source_type='EXPEDITION_REPORT'",
            [oldPlayer],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",
            [oldPlayer, fixture.itemId],
          )
        ).rows[0].quantity,
      ).toBe("2");
      const otherReviewer = "5511999990005@s.whatsapp.net",
        otherPrincipal = randomUUID();
      await pool.query(
        "INSERT INTO admin_principals(id,identity_ref,status) VALUES($1,$2,'ACTIVE')",
        [otherPrincipal, "whatsapp:" + otherReviewer],
      );
      await pool.query(
        "INSERT INTO admin_principal_roles(principal_id,role_id) SELECT $1,id FROM admin_roles WHERE slug='HEADLESS_NARRATOR'",
        [otherPrincipal],
      );
      await pool.query(
        "INSERT INTO admin_principal_scopes(id,principal_id,scope_type,scope_id) VALUES($1,$2,'GLOBAL',NULL)",
        [randomUUID(), otherPrincipal],
      );
      const reviews = await Promise.all([
        send("/explorar revisar normal 100 @treinador", "v4-review-a", null, CHAT, NARRATOR, [
          external,
        ]),
        send("/explorar revisar normal 100 @treinador", "v4-review-b", null, CHAT, otherReviewer, [
          external,
        ]),
      ]);
      expect(
        (
          await pool.query(
            "SELECT status,reviewed_word_count FROM solo_expedition_reports WHERE id=$1",
            [report.id],
          )
        ).rows[0],
      ).toEqual({ status: "APPROVED", reviewed_word_count: 100 });
      const grants = async () =>
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM inventory_ledger WHERE player_id=$1 AND source_type='EXPEDITION_REPORT'",
            [oldPlayer],
          )
        ).rows[0].n;
      expect(await grants()).toBe(2);
      expect(
        active.adapter.sent.some(
          (message) =>
            message.destinationRef === external &&
            String(message.payload.text).includes("• Poké Ball ×2"),
        ),
      ).toBe(true);
      await send(
        "/explorar relatorio https://example.invalid/relatorio-sintetico",
        "v4-report-approved-again",
      );
      expect(active.adapter.sent.at(-1)?.payload.text).toContain("já foi aprovado");
      expect(await grants()).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",
            [oldPlayer, fixture.itemId],
          )
        ).rows[0].quantity,
      ).toBe("4");
      transcript.push(...active.adapter.transcript);
      await active.runtime.stop();
      active = create();
      await active.runtime.start();
      for (const input of reviews) await active.adapter.inject(input);
      await flush();
      expect(await grants()).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM audit_events WHERE action='exploration.report.review' AND target_id=$1",
            [oldPlayer],
          )
        ).rows[0].n,
      ).toBe(1);
      // Leave genuine resumable states for the clone/restore rehearsal.
      await send("/explorar noite");
      await send("/explorar recursos");
      await send("/explorar encerrar confirmar");
      await send("/explorar relatorio https://example.invalid/segundo-relatorio-sintetico");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM solo_expedition_reports WHERE player_id=$1 AND status='SUBMITTED'",
            [oldPlayer],
          )
        ).rows[0].n,
      ).toBe(1);
      await send("/explorar dia");
      const rejectedExternal = "5511999990006@s.whatsapp.net";
      const rejectedTrainer = await new UatBootstrapService(
        pool,
        new PlayerRegistrationService(onboarding),
        new PlayerStarterService(onboarding, new SystemClock(), new CryptoRandomSource()),
        new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null }),
      ).bootstrap(
        { provider: "baileys", externalId: rejectedExternal },
        fixture.narratorPrincipalId,
      );
      if (!rejectedTrainer.ok) throw rejectedTrainer.error;
      await pool.query(
        "INSERT INTO solo_expeditions(id,player_id,period,area_id,phase,elapsed_minutes,consumed_week_key,end_reason) VALUES(gen_random_uuid(),$1,'DAY',$2,'ENDED',60,date_trunc('week',now() AT TIME ZONE 'America/Sao_Paulo')::date,'VOLUNTARY')",
        [rejectedTrainer.value.playerId, fixture.areaId],
      );
      await send(
        "/explorar relatorio https://example.invalid/relatorio-rejeitado",
        "v4-reject-submit",
        null,
        CHAT,
        rejectedExternal,
      );
      await send(
        "/explorar revisar rejeitar 0 @treinador",
        "v4-reject-review",
        null,
        CHAT,
        NARRATOR,
        [rejectedExternal],
      );
      expect(
        (
          await pool.query(
            "SELECT status,reward_result FROM solo_expedition_reports WHERE player_id=$1",
            [rejectedTrainer.value.playerId],
          )
        ).rows,
      ).toEqual([{ status: "REJECTED", reward_result: null }]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM inventory_ledger WHERE player_id=$1 AND source_type='EXPEDITION_REPORT'",
            [rejectedTrainer.value.playerId],
          )
        ).rows[0].n,
      ).toBe(0);
      if (process.env.V4_REHEARSAL_CLONE_NAME) {
        transcript.push(...active.adapter.transcript);
        await active.runtime.stop();
        active = createOperationalSimulatedWhatsAppRuntime({
          pool,
          encounterRngConfig: rng,
          pveBattleConfig: pveConfig,
          combatScenesEnabled: true,
        });
        await active.runtime.start();
        const pair = ["5511999990007@s.whatsapp.net", "5511999990008@s.whatsapp.net"];
        for (const externalId of pair) {
          const registered = await new UatBootstrapService(
            pool,
            new PlayerRegistrationService(onboarding),
            new PlayerStarterService(onboarding, new SystemClock(), new CryptoRandomSource()),
            new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null }),
          ).bootstrap({ provider: "baileys", externalId }, fixture.narratorPrincipalId);
          expect(registered.ok).toBe(true);
        }
        await pool.query(
          "INSERT INTO community_group_capabilities(group_id,capability_key) SELECT id,'pvp' FROM community_groups WHERE chat_ref=$1 ON CONFLICT DO NOTHING",
          [CHAT],
        );
        await send("/desafiar @rival", "v4-pending-challenge", null, CHAT, pair[0]!, [pair[1]!]);
        await send("/aceitar", "v4-pending-accept", null, CHAT, pair[1]!);
        await send("/movimento 1", "v4-persisted-private-action", null, pair[0]!, pair[0]!);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM combat_scene_gates WHERE record->'result'='null'::jsonb AND record->'action'<>'null'::jsonb AND record->'sceneMessageId'='null'::jsonb",
            )
          ).rows[0].n,
        ).toBeGreaterThan(0);
      }
      transcript.push(...active.adapter.transcript);
      if (process.env.SCENE_TRANSCRIPT_FILE)
        await writeFile(
          process.env.SCENE_TRANSCRIPT_FILE + ".v4.json",
          JSON.stringify(transcript, null, 2),
        );
    } finally {
      await active.runtime.stop();
      seeded.mockRestore();
    }
  }, 180000);
  it.each(["deadline", "expired", "catalog", "uncommitted"] as const)(
    "recovers an interrupted search with %s without reviving its actions",
    async (scenario) => {
      const externalId = {
        deadline: "5511999990013@s.whatsapp.net",
        expired: "5511999990014@s.whatsapp.net",
        catalog: "5511999990015@s.whatsapp.net",
        uncommitted: "5511999990016@s.whatsapp.net",
      }[scenario];
      const onboarding = new PostgresPlayerOnboardingRepository(pool);
      const registered = await new UatBootstrapService(
        pool,
        new PlayerRegistrationService(onboarding),
        new PlayerStarterService(onboarding, new SystemClock(), new CryptoRandomSource()),
        new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null }),
      ).bootstrap({ provider: "baileys", externalId }, fixture.narratorPrincipalId);
      if (!registered.ok) throw registered.error;
      const playerId = registered.value.playerId;
      const parsed = parsePlayerId(playerId);
      if (!parsed.ok) throw parsed.error;
      const expedition = new PostgresExpeditionRepository(
        pool,
        new SystemClock(),
        "America/Sao_Paulo",
      );
      const prepared = await expedition.prepare({
        playerId: parsed.value,
        period: "DAY",
        idempotencyKey: scenario + "-prepare",
      });
      if (!prepared.ok) throw prepared.error;
      const create = () =>
        createOperationalSimulatedWhatsAppRuntime({
          pool,
          encounterRngConfig: rng,
          pveBattleConfig: pveConfig,
          combatScenesEnabled: true,
          explorationPreviewTimeZone: "America/Sao_Paulo",
          explorationStagingPreparationEnabled: true,
          explorationStagingSearchSecret: Buffer.alloc(32, 0x72),
          explorationOfflineChoicesEnabled: true,
          explorationReadMoreCombiningCount: 450,
        });
      let runtime = create();
      await runtime.runtime.start();
      let replacement: string | null = null;
      try {
        const rejected =
          scenario === "uncommitted"
            ? vi
                .spyOn(PostgresExpeditionV4StagingSearch.prototype, "execute")
                .mockResolvedValueOnce(err(appError("FLOW_BLOCKED", "fixture before commit")))
            : undefined;
        const fault = vi
          .spyOn(PostgresMessagingRepository.prototype, "completeIncoming")
          .mockRejectedValueOnce(new Error("fixture before response"));
        const externalMessageId = "search-recovery-" + scenario;
        const input = await runtime.adapter.injectText({
          senderRef: externalId,
          chatRef: CHAT,
          text: "/explorar buscar",
          externalMessageId,
        });
        fault.mockRestore();
        rejected?.mockRestore();
        expect(
          (
            await pool.query("SELECT status FROM inbox_messages WHERE external_message_id=$1", [
              externalMessageId,
            ])
          ).rows,
        ).toEqual([{ status: "FAILED" }]);
        await runtime.runtime.stop();

        const encounter = (
          await pool.query("SELECT id FROM encounters WHERE player_id=$1", [playerId])
        ).rows[0];
        if (scenario === "uncommitted") {
          expect(encounter).toBeUndefined();
        } else {
          expect(encounter).toBeDefined();
          if (scenario === "deadline" || scenario === "expired") {
            await pool.query(
              "UPDATE encounters SET created_at=now()-interval '1 minute', expires_at=now()-interval '1 second' WHERE id=$1",
              [encounter.id],
            );
            if (scenario === "expired") {
              const repository = new PostgresEncounterRepository(pool);
              await repository.transaction((tx) => tx.expireDue(new Date(), 100));
            }
          } else {
            replacement = randomUUID();
            await pool.query(
              `INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id)
              SELECT $1,9002,'Synthetic recovery replacement','DRAFT',default_ruleset_id FROM content_releases WHERE id=$2`,
              [replacement, fixture.releaseId],
            );
            await pool.query(
              `UPDATE content_releases SET status='VALIDATED',validated_at=now(),
              validation_report='{"valid":true,"issues":[]}',content_fingerprint=$2 WHERE id=$1`,
              [replacement, "c".repeat(64)],
            );
            await pool.query(
              "UPDATE content_releases SET status='PUBLISHED',published_at=now() WHERE id=$1",
              [replacement],
            );
            await pool.query(
              "UPDATE content_release_pointers SET content_release_id=$1 WHERE pointer_key='ACTIVE'",
              [replacement],
            );
          }
        }
        const snapshot = async () =>
          (
            await pool.query(
              `SELECT (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM encounters e WHERE e.player_id=$1) AS encounters,
                  (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM solo_expeditions e WHERE e.player_id=$1) AS expeditions,
                  (SELECT count(*)::int FROM solo_expedition_receipts WHERE player_id=$1 AND operation='ACTION_SEARCH_FREE') AS receipts,
                  (SELECT count(*)::int FROM capture_attempts WHERE player_id=$1) AS captures,
                  (SELECT count(*)::int FROM inventory_ledger WHERE player_id=$1) AS ledger,
                  (SELECT count(*)::int FROM solo_incidental_menu_snapshots WHERE player_id=$1) AS menus`,
              [playerId],
            )
          ).rows;
        const before = await snapshot();
        runtime = create();
        await runtime.runtime.start();
        await Promise.all([runtime.adapter.inject(input), runtime.adapter.inject(input)]);
        await runtime.runtime.flushOutbox();
        await runtime.adapter.inject(input);
        await runtime.runtime.flushOutbox();
        expect(await snapshot()).toEqual(before);
        expect(before[0].receipts).toBe(scenario === "uncommitted" ? 0 : 1);
        expect(runtime.expeditionPostSentFailures).toEqual([]);
        const confirmed = runtime.adapter.sent.filter((message) =>
          String(message.payload.text).includes("Busca anterior confirmada"),
        );
        if (scenario === "uncommitted") {
          expect(confirmed).toHaveLength(0);
          expect(
            runtime.adapter.sent.some((message) =>
              String(message.payload.text).includes("Busca não confirmada"),
            ),
          ).toBe(true);
        } else {
          expect(confirmed).toHaveLength(1);
          expect(confirmed[0]?.destinationRef).toBe(externalId);
          expect(confirmed[0]?.payload.text).toContain("Bellsprout");
          expect(confirmed[0]?.payload.expeditionSearch).toBeUndefined();
          expect(confirmed[0]?.payload.expeditionMenu).toBeUndefined();
        }
      } finally {
        await runtime.runtime.stop();
        if (replacement !== null)
          await pool.query(
            "UPDATE content_release_pointers SET content_release_id=$1 WHERE pointer_key='ACTIVE'",
            [fixture.releaseId],
          );
      }
    },
  );

  it.each(["LOST", "LOST_BLOCKED", "WON", "CLOCK"] as const)(
    "settles expedition battle %s with durable time and quota",
    async (outcome) => {
      const defeat = outcome === "LOST" || outcome === "LOST_BLOCKED";
      const onboarding = new PostgresPlayerOnboardingRepository(pool);
      const registered = await new UatBootstrapService(
        pool,
        new PlayerRegistrationService(onboarding),
        new PlayerStarterService(onboarding, new SystemClock(), new CryptoRandomSource()),
        new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null }),
      ).bootstrap(
        {
          provider: "baileys",
          externalId: defeat
            ? outcome === "LOST_BLOCKED"
              ? "5511999990099@s.whatsapp.net"
              : "5511999990010@s.whatsapp.net"
            : outcome === "CLOCK"
              ? "5511999990012@s.whatsapp.net"
              : "5511999990011@s.whatsapp.net",
        },
        fixture.narratorPrincipalId,
      );
      if (!registered.ok) throw registered.error;
      const parsed = parsePlayerId(registered.value.playerId);
      if (!parsed.ok) throw parsed.error;
      const player = parsed.value,
        clock = new SystemClock();
      const expeditions = new PostgresExpeditionRepository(pool, clock, "America/Sao_Paulo");
      const prepared = await expeditions.prepare({
        playerId: player,
        period: "DAY",
        idempotencyKey: "blackout-prepare",
      });
      if (!prepared.ok) throw prepared.error;
      const seeds = new AesEncounterSeedProvider(rng.encryptionKey, 1, () => Buffer.alloc(32));
      const search = new PostgresExpeditionV4StagingSearch(
        pool,
        expeditions,
        { decide: async () => ({ ok: true, value: { kind: "TRAIL" } }) },
        createDirectEncounterEffect({
          seedProvider: seeds,
          clock,
          feature: { enabled: true, reason: null },
        }),
      );
      await pool.query(
        `INSERT INTO player_pokedex_species(player_id,species_id,seen_count,caught_count,first_seen_at,last_seen_at)
      SELECT $1,id,1,0,now(),now() FROM pokemon_species WHERE slug='uat-bellsprout' ON CONFLICT(player_id,species_id) DO NOTHING`,
        [player],
      );
      const searched = await search.execute({
        targetSpeciesSlug: "uat-bellsprout",
        playerId: player,
        expeditionId: prepared.value.expedition.expeditionId,
        expectedRevision: prepared.value.expedition.revision,
        idempotencyKey: "blackout-search",
      });
      if (!searched.ok) throw searched.error;
      let encounterId: string | null;
      if (defeat) {
        const follow = new PostgresExpeditionV4StagingTrailFollow(
          pool,
          expeditions,
          createDirectEncounterEffect({
            seedProvider: seeds,
            clock,
            feature: { enabled: true, reason: null },
          }),
        );
        const followed = await follow.execute({
          playerId: player,
          expeditionId: prepared.value.expedition.expeditionId,
          expectedRevision: searched.value.transition.expedition.revision,
          idempotencyKey: "blackout-follow",
          sourceOutcomeId: searched.value.outcome.outcomeId,
        });
        if (!followed.ok) throw followed.error;
        expect(followed.value.encounterPreview.speciesName).toBe("Bellsprout");
        expect(
          (
            await follow.execute({
              playerId: player,
              expeditionId: prepared.value.expedition.expeditionId,
              expectedRevision: searched.value.transition.expedition.revision,
              idempotencyKey: "blackout-follow",
              sourceOutcomeId: searched.value.outcome.outcomeId,
            })
          ).ok,
        ).toBe(true);
        encounterId = followed.value.outcome.encounterId;
      } else {
        const fishing = new PostgresFishingAttemptRepository(pool, {
          clock,
          seedProvider: seeds,
          fishingDayTimeZone: "America/Sao_Paulo",
          expeditionEnabled: true,
          feature: { enabled: true, reason: null },
        });
        const attempted = await fishing.reserveAndResolve({
          playerId: player,
          idempotencyKey: "victory-fishing-" + outcome,
          roll: 10,
        });
        if (!attempted.ok) throw attempted.error;
        encounterId = attempted.value.encounter?.encounterId ?? null;
        expect((await expeditions.current(player))?.elapsedMinutes).toBe(30);
      }
      if (!encounterId) throw new Error("Fixture requires an encounter");
      await pool.query(
        defeat
          ? "UPDATE pokemon_instances SET current_hp=1 WHERE owner_player_id=$1"
          : "UPDATE pokemon_instances SET level=100 WHERE owner_player_id=$1",
        [player],
      );
      if (outcome === "CLOCK")
        await pool.query("UPDATE solo_expeditions SET elapsed_minutes=710 WHERE id=$1", [
          prepared.value.expedition.expeditionId,
        ]);
      const encounter = new EncounterService(new PostgresEncounterRepository(pool), seeds, clock, {
        enabled: true,
        reason: null,
      });
      const view = await encounter.observe({
        playerId: player,
        encounterId: encounterId as never,
        expectedRevision: 0n,
      });
      if (!view.ok) throw view.error;
      const engaged = await encounter.engage({
        playerId: player,
        encounterId: view.value.encounterId,
        expectedRevision: view.value.revision,
      });
      if (!engaged.ok) throw engaged.error;
      const started = await encounter.startBattle({
        playerId: player,
        encounterId: view.value.encounterId,
        expectedRevision: engaged.value.revision,
      });
      if (!started.ok) throw started.error;
      const create = () =>
        createPveBattleRuntime(pool, { ...pveConfig, expeditionBlackoutEnabled: true });
      let battle = create();
      const initial = await battle.battle.initialize(
        started.value.battleId,
        defeat ? "WILD" : "PLAYER",
      );
      if (!initial.ok) throw initial.error;
      if (!defeat) {
        const turn = {
          battleId: started.value.battleId,
          playerId: player,
          expectedVersion: initial.value.state.version,
          idempotencyKey: "victory-turn-" + outcome,
          action: {
            type: "USE_MOVE" as const,
            moveSlot: 1,
            actorParticipantId: initial.value.state.combatants.find(
              (c) => c.participantKind === "PLAYER_POKEMON",
            )!.participantId,
            targetParticipantId: initial.value.state.combatants.find(
              (c) => c.participantKind === "WILD_POKEMON",
            )!.participantId,
          },
        };
        const won = await battle.battle.resolvePlayerTurn(turn);
        expect(won).toMatchObject({ ok: true, value: { state: { status: "WON" } } });
        expect((await create().battle.resolvePlayerTurn(turn)).ok).toBe(true);
        expect(
          (
            await pool.query(
              "SELECT phase,end_reason,elapsed_minutes FROM solo_expeditions WHERE id=$1",
              [prepared.value.expedition.expeditionId],
            )
          ).rows,
        ).toEqual([
          outcome === "CLOCK"
            ? { phase: "ENDED", end_reason: "CLOCK", elapsed_minutes: 720 }
            : { phase: "ACTIVE", end_reason: null, elapsed_minutes: 60 },
        ]);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM solo_expedition_receipts WHERE player_id=$1 AND idempotency_key=$2",
              [player, "battle-settlement:" + started.value.battleId],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        return;
      }
      const before = (
        await pool.query(
          "SELECT id,current_hp,xp::text FROM pokemon_instances WHERE owner_player_id=$1 ORDER BY id",
          [player],
        )
      ).rows;
      const wallets = async () =>
        (
          await pool.query(
            "SELECT to_jsonb(w) AS row FROM wallet_balances w WHERE player_id=$1 ORDER BY currency_id",
            [player],
          )
        ).rows;
      const money = await wallets();
      await pool.query(`CREATE FUNCTION fail_blackout_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.idempotency_key LIKE 'battle-blackout:%' THEN RAISE EXCEPTION 'fixture crash before blackout receipt'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_blackout_fixture BEFORE INSERT ON solo_expedition_receipts FOR EACH ROW EXECUTE FUNCTION fail_blackout_fixture()`);
      try {
        const lost = await battle.battle.resolvePlayerTurn({
          battleId: started.value.battleId,
          playerId: player,
          expectedVersion: initial.value.state.version,
          idempotencyKey: "blackout-turn-" + outcome,
          action: {
            type: "USE_MOVE",
            moveSlot: 1,
            actorParticipantId: initial.value.state.combatants.find(
              (c) => c.participantKind === "PLAYER_POKEMON",
            )!.participantId,
            targetParticipantId: initial.value.state.combatants.find(
              (c) => c.participantKind === "WILD_POKEMON",
            )!.participantId,
          },
        });
        expect(lost).toMatchObject({ ok: false, error: { code: "BATTLE_AFTERMATH_FAILED" } });
        expect((await expeditions.current(player))?.phase).toBe("ACTIVE");
        expect(
          (await pool.query("SELECT status FROM battles WHERE id=$1", [started.value.battleId]))
            .rows[0].status,
        ).toBe("LOST");
      } finally {
        await pool.query(
          "DROP TRIGGER fail_blackout_fixture ON solo_expedition_receipts; DROP FUNCTION fail_blackout_fixture()",
        );
      }
      await pool.query("UPDATE player_locations SET area_id=$2 WHERE player_id=$1", [
        player,
        fixture.yun,
      ]);
      const blocked = outcome === "LOST_BLOCKED";
      if (!blocked) {
        await pool.query(
          "INSERT INTO trainer_unlocks(player_id,unlock_key,source_type,source_id) VALUES($1,'proof.blackout.lock','FIXTURE','v4')",
          [player],
        );
      }
      battle = create();
      await battle.runMaintenance();
      expect(
        (await pool.query("SELECT area_id FROM player_locations WHERE player_id=$1", [player]))
          .rows,
      ).toEqual([{ area_id: blocked ? fixture.yun : fixture.areaId }]);
      expect(
        (
          await pool.query(
            `SELECT result->>'blackoutNeedsStaff' AS needs_staff FROM solo_expedition_receipts
        WHERE player_id=$1 AND idempotency_key LIKE 'battle-blackout:%'`,
            [player],
          )
        ).rows,
      ).toEqual([{ needs_staff: blocked ? "true" : null }]);
      const state = async () =>
        (
          await pool.query(
            "SELECT phase,end_reason,elapsed_minutes,consumed_week_key::text,revision::text FROM solo_expeditions WHERE id=$1",
            [prepared.value.expedition.expeditionId],
          )
        ).rows;
      const ended = await state();
      expect(ended[0]).toMatchObject({
        phase: "ENDED",
        end_reason: "BLACKOUT",
        elapsed_minutes: 75,
      });
      expect(ended[0].consumed_week_key).not.toBeNull();
      battle = create();
      await battle.runMaintenance();
      expect(await state()).toEqual(ended);
      expect(await wallets()).toEqual(money);
      const after = (
        await pool.query(
          "SELECT id,current_hp,xp::text FROM pokemon_instances WHERE owner_player_id=$1 ORDER BY id",
          [player],
        )
      ).rows;
      expect(after.map((p) => ({ id: p.id, xp: p.xp }))).toEqual(
        before.map((p) => ({ id: p.id, xp: p.xp })),
      );
      expect(after.every((p) => p.current_hp === 0)).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM solo_expedition_receipts WHERE player_id=$1 AND idempotency_key LIKE 'battle-blackout:%'",
            [player],
          )
        ).rows[0].n,
      ).toBe(1);
    },
  );
  it("authorizes private operational V4 and falls back to legacy with committed V4 data", async () => {
    const onboarding = new PostgresPlayerOnboardingRepository(pool);
    const bootstrap = new UatBootstrapService(
      pool,
      new PlayerRegistrationService(onboarding),
      new PlayerStarterService(onboarding, new SystemClock(), new CryptoRandomSource()),
      new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null }),
    );
    const ownerRef = "5511999990061@s.whatsapp.net";
    const ordinaryRef = "5511999990062@s.whatsapp.net";
    const register = async (externalId: string) => {
      const result = await bootstrap.bootstrap(
        { provider: "baileys", externalId },
        fixture.narratorPrincipalId,
      );
      if (!result.ok) throw result.error;
      const id = parsePlayerId(result.value.playerId);
      if (!id.ok) throw id.error;
      return id.value;
    };
    const owner = await register(ownerRef);
    const ordinary = await register(ordinaryRef);
    const create = (enabled: boolean) =>
      createOperationalSimulatedWhatsAppRuntime({
        pool,
        encounterRngConfig: rng,
        pveBattleConfig: pveConfig,
        operationalExpeditionPreview: enabled
          ? {
              allowedPlayerIds: new Set([owner]),
              timeZone: "America/Sao_Paulo",
              playSecret: Buffer.alloc(32, 0x72),
            }
          : null,
      });
    let live = create(true);
    const occurredAt = new Date().toISOString();
    const send = async (
      senderRef: string,
      text: string,
      externalMessageId: string,
      replyToExternalMessageId: string | null = null,
    ) => {
      await live.adapter.injectText({
        senderRef,
        chatRef: replyToExternalMessageId ? senderRef : CHAT,
        text,
        externalMessageId,
        occurredAt,
        replyToExternalMessageId,
      });
      await live.runtime.flushOutbox();
      await live.runtime.flushOutbox();
    };
    const receipts = async () =>
      (
        await pool.query(
          "SELECT player_id,operation,result FROM solo_expedition_receipts WHERE player_id IN ($1,$2) ORDER BY created_at,idempotency_key",
          [owner, ordinary],
        )
      ).rows;
    await live.runtime.start();
    try {
      await send(ordinaryRef, "/explorar dia", "op-v4-denied");
      expect(await receipts()).toEqual([]);
      await send(ownerRef, "/explorar dia", "op-v4-prepare");
      const trailRoll = vi
        .spyOn(PublishedSearchOutcomePolicy.prototype, "decide")
        .mockResolvedValueOnce({ ok: true, value: { kind: "TRAIL" } });
      try {
        await send(ownerRef, "/explorar buscar", "op-v4-search");
      } finally {
        trailRoll.mockRestore();
      }
      const uncommitted = vi
        .spyOn(PostgresExpeditionV4StagingTrailFollow.prototype, "execute")
        .mockRejectedValueOnce(new Error("fixture crash before trail commit"));
      try {
        await send(ownerRef, "/explorar seguir", "op-v4-follow-uncommitted");
      } finally {
        uncommitted.mockRestore();
      }
      await send(ownerRef, "/explorar seguir", "op-v4-follow-uncommitted");
      expect((await receipts()).map((row) => row.operation)).toEqual([
        "PREPARE",
        "ACTION_SEARCH_FREE",
      ]);
      expect(
        live.adapter.sent.some((message) =>
          String(message.payload.text).includes("Ação não confirmada."),
        ),
      ).toBe(true);
      const trailFailure = vi
        .spyOn(PostgresMessagingRepository.prototype, "completeIncoming")
        .mockRejectedValueOnce(new Error("fixture crash after trail commit"));
      try {
        await send(ownerRef, "/explorar seguir", "op-v4-follow");
      } finally {
        trailFailure.mockRestore();
      }
      await live.runtime.stop();
      live = create(true);
      await live.runtime.start();
      await send(ownerRef, "/explorar seguir", "op-v4-follow");
      const confirmed = await receipts();
      expect(confirmed.map((row) => row.operation)).toEqual([
        "PREPARE",
        "ACTION_SEARCH_FREE",
        "ACTION_FOLLOW_TRAIL",
      ]);
      const menu = live.adapter.sent.find((message) => message.payload.expeditionMenu);
      expect(menu).toBeDefined();
      expect(live.expeditionPostSentFailures).toEqual([]);
      const quote = menu!.id.replaceAll("-", "").toUpperCase();
      const battleFailure = vi
        .spyOn(PostgresMessagingRepository.prototype, "completeIncoming")
        .mockRejectedValueOnce(new Error("fixture crash after battle commit"));
      try {
        await send(ownerRef, "1", "op-v4-battle", quote);
      } finally {
        battleFailure.mockRestore();
      }
      const battleReceipts = async () =>
        (
          await pool.query(
            "SELECT battle_id, outcome_id FROM solo_expedition_battle_receipts WHERE player_id=$1",
            [owner],
          )
        ).rows;
      const committedBattle = await battleReceipts();
      expect(committedBattle).toHaveLength(1);
      await live.runtime.stop();
      live = create(false);
      await live.runtime.start();
      await send(ownerRef, "/explorar buscar", "op-v4-search");
      await send(ownerRef, "1", "op-v4-battle", quote);
      await send(ownerRef, "2", "op-v4-stale-quote", quote);
      await send(ordinaryRef, "/combate", "op-v4-legacy-combat");
      expect(await receipts()).toEqual(confirmed);
      expect(await battleReceipts()).toEqual(committedBattle);
      expect(
        live.adapter.sent.some(
          (message) =>
            message.destinationRef === CHAT &&
            typeof message.payload.text === "string" &&
            message.payload.text.includes("/movimento"),
        ),
      ).toBe(true);
      expect(live.adapter.sent.some((message) => message.payload.expeditionMenu)).toBe(false);
      await live.runtime.stop();
      live = create(true);
      await live.runtime.start();
      await send(ownerRef, "1", "op-v4-battle", quote);
      expect(await battleReceipts()).toEqual(committedBattle);
    } finally {
      await live.runtime.stop();
    }
  });
});
