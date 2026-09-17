import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeBaileysMessage } from "../../src/adapters/whatsapp/baileys-normalizer.js";
import { UatBootstrapService } from "../../src/modules/admin/uat-bootstrap.js";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type { OutboundMessageAdapter } from "../../src/modules/messaging/ports.js";
import { MessagingService, OutboxWorker } from "../../src/modules/messaging/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { SystemClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { CryptoRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

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
  readonly releaseId: string;
  readonly areaId: string;
  readonly itemId: string;
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
      allowedEncounterStates: ["IN_BATTLE"],
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
       '{"schemaVersion":1,"kind":"TOWN","safePoint":true,"startingArea":true,"relocationPriority":0}'::jsonb
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

  return { releaseId, areaId, itemId, narratorPrincipalId };
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
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminPool.end();
    }
  }, 60_000);

  function runtime() {
    const composition = createOperationalMessagingComposition(pool, rng, null, pveConfig);
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
    expect(await activeRuntime.worker.runOnce()).toMatchObject({ failed: 0, sent: 1 });

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
    expect(await activeRuntime.worker.runOnce()).toMatchObject({ failed: 0, sent: 1 });

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
    expect(texts.some((text) => text.includes("ENCONTRO SELVAGEM · GRUPO"))).toBe(true);
    expect(texts.some((text) => text.includes("Batalha iniciada"))).toBe(true);
    expect(texts.some((text) => text.includes("CAPTURA CONCLUÍDA"))).toBe(true);
    expect(texts.every((text) => !UUID_IN_TEXT.test(text))).toBe(true);

    const outbox = await pool.query<{ status: string; count: string }>(
      `SELECT status,count(*)::text AS count
         FROM outbox_messages
         GROUP BY status
         ORDER BY status`,
    );
    expect(outbox.rows).toEqual([
      { status: "PENDING", count: "1" },
      { status: "SENT", count: "4" },
    ]);
  }, 60_000);
});
