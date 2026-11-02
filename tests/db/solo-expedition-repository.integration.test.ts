import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresExpeditionRepository } from "../../src/platform/exploration/postgres-expedition-repository.js";
import { PostgresExpeditionV4StatusReader } from "../../src/platform/exploration/postgres-expedition-v4-status-reader.js";
import { PostgresExpeditionV4StagingSearch } from "../../src/platform/exploration/postgres-expedition-v4-search.js";
import { PostgresExpeditionSearchSentProof } from "../../src/platform/exploration/postgres-expedition-search-sent-proof.js";
import { PostgresExpeditionQuotedEncounterProof } from "../../src/platform/exploration/postgres-expedition-quoted-encounter-proof.js";
import { PostgresExpeditionIssuedMenuReplyProof } from "../../src/platform/exploration/postgres-expedition-issued-menu-reply-proof.js";
import { PostgresExpeditionReadOnlyMenuIssuer } from "../../src/platform/exploration/postgres-expedition-readonly-menu-issuer.js";
import { PostgresExpeditionOfflineActionableMenuIssuer } from "../../src/platform/exploration/postgres-expedition-offline-actionable-menu-issuer.js";
import { PostgresExpeditionCaptureConfirmationRecovery } from "../../src/platform/exploration/postgres-expedition-capture-confirmation-recovery.js";
import { ExpeditionCanonicalChoiceStagingResolver } from "../../src/modules/exploration/expedition-canonical-choice-staging.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { CaptureService } from "../../src/modules/capture/service.js";
import { PostgresCaptureRepository } from "../../src/platform/capture/postgres-capture-repository.js";
import { AesEncounterSeedProvider } from "../../src/platform/rng/encrypted-seed-provider.js";
import type { CaptureContext } from "../../src/modules/capture/contracts.js";
import { ExpeditionSearchEngagementAfterSent } from "../../src/modules/exploration/expedition-search-engagement-after-sent.js";
import { EncounterService } from "../../src/modules/encounter/service.js";
import { EncounterOperationalReadService } from "../../src/modules/encounter/operational-read-service.js";
import { ExpeditionQuotedReplyReadOnlyStagingResolver } from "../../src/modules/exploration/expedition-quoted-reply-readonly-staging.js";
import {
  IncomingMessageSchema,
  type MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { MessagingService, OutboxWorker } from "../../src/modules/messaging/service.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { ExpeditionSearchPostSentHook } from "../../src/modules/exploration/expedition-search-post-sent-hook.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresEncounterRepository } from "../../src/platform/encounter/postgres-encounter-repository.js";
import { PublishedSearchOutcomePolicy } from "../../src/platform/exploration/expedition-published-outcome-policy.js";
import {
  createSearchOutcomeEffect,
  readStoredSearchOutcome,
} from "../../src/platform/exploration/expedition-search-outcome-effect.js";
import {
  createCorrelationId,
  createEncounterId,
  createPlayerId,
  type PlayerId,
} from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const dbName = "pokemon_solo_exp_" + process.pid + "_" + Date.now();

function databaseUrlFor(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = "/" + name;
  return url.toString();
}

describe.sequential("solo expedition PostgreSQL draft persistence", () => {
  let adminPool: Pool;
  let pool: Pool;
  let clock: ManualClock;
  let store: PostgresExpeditionRepository;
  let publishedReleaseId: string;
  let publishedBallItemId: string;
  let publishedCaptureSnapshot: CaptureContext["encounterSnapshot"];
  let activeAreaId: string;
  let unpublishedAreaId: string;
  let inactiveRegionAreaId: string;
  let outsideLaunchAreaId: string;

  async function trainer(areaId?: string): Promise<PlayerId> {
    const id = createPlayerId();
    await pool.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [id]);
    await pool.query(
      "INSERT INTO onboarding_states(player_id,state,starter_claim_key,completed_at) VALUES ($1,'COMPLETE','exploration-fixture',now())",
      [id],
    );
    await pool.query("INSERT INTO player_locations(player_id,area_id) VALUES ($1,$2)", [
      id,
      areaId ?? activeAreaId,
    ]);
    return id;
  }

  async function prepare(playerId: PlayerId, key: string) {
    const result = await store.prepare({
      playerId,
      period: "DAY",
      idempotencyKey: key,
    });
    if (!result.ok) throw result.error;
    return result.value.expedition;
  }

  async function count(
    table: "solo_expeditions" | "solo_expedition_receipts" | "solo_expedition_search_outcomes",
    playerId: PlayerId,
  ): Promise<number> {
    const sql = "SELECT count(*)::int AS n FROM " + table + " WHERE player_id=$1";
    const result = await pool.query<{ n: number }>(sql, [playerId]);
    return result.rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query('CREATE DATABASE "' + dbName + '"');
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 6 });
    await runMigrations(pool, { appliedBy: "solo-exploration-draft-vitest" });
    const sql = await readFile(
      new URL("../../db/drafts/solo_exploration_v1_schema.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(`CREATE TABLE solo_search_effect_test (
      id UUID PRIMARY KEY,
      player_id UUID NOT NULL REFERENCES players(id),
      expedition_id UUID NOT NULL REFERENCES solo_expeditions(id)
    )`);
    const rulesetId = randomUUID();
    publishedReleaseId = randomUUID();
    const activeRegionId = randomUUID();
    const unpublishedRegionId = randomUUID();
    const inactiveRegionId = randomUUID();
    const outsideLaunchRegionId = randomUUID();
    activeAreaId = randomUUID();
    unpublishedAreaId = randomUUID();
    inactiveRegionAreaId = randomUUID();
    outsideLaunchAreaId = randomUUID();
    await pool.query(
      "INSERT INTO rulesets(id,key,version,engine_contract_version,config,status) VALUES ($1,'solo-expedition-proof',1,1,'{}'::jsonb,'DRAFT')",
      [rulesetId],
    );
    await pool.query(
      "UPDATE rulesets SET status='VALIDATED',validated_at=now(),validation_report=$2::jsonb,config_fingerprint=$3 WHERE id=$1",
      [rulesetId, JSON.stringify({ valid: true, issues: [] }), "a".repeat(64)],
    );
    await pool.query("UPDATE rulesets SET status='PUBLISHED',published_at=now() WHERE id=$1", [
      rulesetId,
    ]);
    await pool.query(
      "INSERT INTO regions(id,slug) VALUES ($1,'zhoulia'),($2,'solo-unpublished-proof'),($3,'solo-inactive-region-proof'),($4,'other-allowed-region')",
      [activeRegionId, unpublishedRegionId, inactiveRegionId, outsideLaunchRegionId],
    );
    await pool.query(
      "INSERT INTO areas(id,region_id,slug) VALUES ($1,$5,'vila-dos-arrozais'),($2,$6,'solo-unpublished-area'),($3,$7,'solo-inactive-region-area'),($4,$8,'published-outside-zhoulia')",
      [
        activeAreaId,
        unpublishedAreaId,
        inactiveRegionAreaId,
        outsideLaunchAreaId,
        activeRegionId,
        unpublishedRegionId,
        inactiveRegionId,
        outsideLaunchRegionId,
      ],
    );
    await pool.query(
      "INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id) VALUES ($1,999993,'Solo Expedition Draft UAT','DRAFT',$2)",
      [publishedReleaseId, rulesetId],
    );
    await pool.query(
      "INSERT INTO region_revisions(id,content_release_id,region_id,display_name,active,data) VALUES ($1,$4,$5,'Zhoulia',TRUE,'{}'::jsonb),($2,$4,$6,'Solo Inactive Region',FALSE,'{}'::jsonb),($3,$4,$7,'Other Published Region',TRUE,'{}'::jsonb)",
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        publishedReleaseId,
        activeRegionId,
        inactiveRegionId,
        outsideLaunchRegionId,
      ],
    );
    await pool.query(
      "INSERT INTO area_revisions(id,content_release_id,area_id,display_name,active,data) VALUES ($1,$4,$5,'Vila dos Arrozais',TRUE,$8::jsonb),($2,$4,$6,'Solo Inactive Region Area',TRUE,$8::jsonb),($3,$4,$7,'Other Published Area',TRUE,$8::jsonb)",
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        publishedReleaseId,
        activeAreaId,
        inactiveRegionAreaId,
        outsideLaunchAreaId,
        JSON.stringify({
          schemaVersion: 1,
          kind: "ROUTE",
          safePoint: false,
          startingArea: false,
          relocationPriority: 10,
        }),
      ],
    );
    // Catalog revisions must be authored only while their release is DRAFT.
    // Never bypass the PUBLISHED child-mutation trigger in the test database.
    publishedBallItemId = randomUUID();
    await pool.query("INSERT INTO items(id,slug) VALUES($1,$2)", [
      publishedBallItemId,
      "pg18-staging-ball-" + publishedBallItemId,
    ]);
    await pool.query(
      `INSERT INTO item_revisions(
         id,content_release_id,item_id,display_name,item_kind,effect_key,effect_config,active
       ) VALUES($1,$2,$3,'Poké Ball','BALL','catch-modifier',$4::jsonb,TRUE)`,
      [
        randomUUID(),
        publishedReleaseId,
        publishedBallItemId,
        JSON.stringify({ multiplierBasisPoints: 10000 }),
      ],
    );
    // One real, published and FK-valid wild Pokémon for CaptureService's
    // PostgreSQL transaction: master catalog is authored before publication.
    const speciesId = randomUUID();
    const formId = randomUUID();
    const typeId = randomUUID();
    const natureId = randomUUID();
    const abilityId = randomUUID();
    const moveId = randomUUID();
    await pool.query("INSERT INTO pokemon_types(id,slug) VALUES($1,$2)", [
      typeId,
      "pg18-capture-type-" + typeId,
    ]);
    await pool.query("INSERT INTO pokemon_species(id,national_dex,slug) VALUES($1,9997,$2)", [
      speciesId,
      "pg18-capture-species-" + speciesId,
    ]);
    await pool.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES($1,$2,'default')", [
      formId,
      speciesId,
    ]);
    await pool.query("INSERT INTO natures(id,slug) VALUES($1,$2)", [
      natureId,
      "pg18-capture-nature-" + natureId,
    ]);
    await pool.query("INSERT INTO abilities(id,slug) VALUES($1,$2)", [
      abilityId,
      "pg18-capture-ability-" + abilityId,
    ]);
    await pool.query("INSERT INTO moves(id,slug) VALUES($1,$2)", [
      moveId,
      "pg18-capture-move-" + moveId,
    ]);
    await pool.query(
      "INSERT INTO pokemon_type_revisions(id,content_release_id,type_id,display_name) VALUES($1,$2,$3,'Normal')",
      [randomUUID(), publishedReleaseId, typeId],
    );
    await pool.query(
      "INSERT INTO pokemon_species_revisions(id,content_release_id,species_id,display_name,catch_rate,base_exp) VALUES($1,$2,$3,'Published Testmon',255,50)",
      [randomUUID(), publishedReleaseId, speciesId],
    );
    await pool.query(
      `INSERT INTO pokemon_form_revisions(
         id,content_release_id,form_id,display_name,type1_id,
         base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed
       ) VALUES($1,$2,$3,'Published Testmon',$4,40,45,40,35,35,56)`,
      [randomUUID(), publishedReleaseId, formId, typeId],
    );
    await pool.query(
      "INSERT INTO ability_revisions(id,content_release_id,ability_id,display_name) VALUES($1,$2,$3,'Test Ability')",
      [randomUUID(), publishedReleaseId, abilityId],
    );
    await pool.query(
      "INSERT INTO nature_revisions(id,content_release_id,nature_id,display_name) VALUES($1,$2,$3,'Hardy')",
      [randomUUID(), publishedReleaseId, natureId],
    );
    await pool.query(
      `INSERT INTO move_revisions(
         id,content_release_id,move_id,display_name,type_id,category,power,accuracy,priority,max_pp
       ) VALUES($1,$2,$3,'Tackle',$4,'PHYSICAL',40,100,0,35)`,
      [randomUUID(), publishedReleaseId, moveId, typeId],
    );
    publishedCaptureSnapshot = {
      schemaVersion: 1,
      formId,
      speciesId,
      level: 3,
      type1Id: typeId,
      type2Id: null,
      baseStats: { hp: 40, attack: 45, defense: 40, spAttack: 35, spDefense: 35, speed: 56 },
      ivs: { hp: 1, attack: 2, defense: 3, spAttack: 4, spDefense: 5, speed: 6 },
      natureId,
      abilityId,
      moves: [{ moveId, ppCurrent: 35 }],
      maxHp: 18,
      currentHp: 1,
      shiny: false,
      gender: null,
    };
    await pool.query(
      "UPDATE content_releases SET status='VALIDATED',validated_at=now(),validation_report=$2::jsonb,content_fingerprint=$3 WHERE id=$1",
      [publishedReleaseId, JSON.stringify({ valid: true, issues: [] }), "b".repeat(64)],
    );
    await pool.query(
      "UPDATE content_releases SET status='PUBLISHED',published_at=now() WHERE id=$1",
      [publishedReleaseId],
    );
    await pool.query(
      "INSERT INTO content_release_pointers(pointer_key,content_release_id) VALUES ('ACTIVE',$1)",
      [publishedReleaseId],
    );
    clock = new ManualClock(new Date("2026-10-19T12:00:00Z"));
    store = new PostgresExpeditionRepository(pool, clock, "America/Maceio");
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      // pool.end() must close every test-owned connection. Force-dropping the
      // database can terminate a still-observing pg client with an uncaught
      // 57P01, giving a false-red CI even when all assertions passed.
      // A plain DROP exposes real leaks instead of masking them.
      await adminPool.query('DROP DATABASE IF EXISTS "' + dbName + '"');
      await adminPool.end();
    }
  });

  it("reads real V4 NONE/PREPARING/ACTIVE status and weekly quota without writes or player leaks", async () => {
    const reader = new PostgresExpeditionV4StatusReader(pool);
    const owner = await trainer();
    const other = await trainer();
    const week = "2026-10-19";

    expect(await reader.read(owner, week)).toEqual({ expedition: null, usedThisWeek: 0 });
    expect(await reader.read(other, week)).toEqual({ expedition: null, usedThisWeek: 0 });

    const first = await prepare(owner, "v4-status-prepare");
    const preparingView = await reader.read(owner, week);
    expect(preparingView).toMatchObject({
      expedition: {
        playerId: owner,
        expeditionId: first.expeditionId,
        phase: "PREPARING",
        elapsedMinutes: 0,
      },
      usedThisWeek: 0,
    });
    expect(await reader.read(other, week)).toEqual({ expedition: null, usedThisWeek: 0 });

    const advanced = await store.advance({
      playerId: owner,
      expeditionId: first.expeditionId,
      expectedRevision: first.revision,
      minutes: 30,
      idempotencyKey: "v4-status-first-cost",
    });
    expect(advanced.ok).toBe(true);
    const receiptCount = await count("solo_expedition_receipts", owner);
    const activeView = await reader.read(owner, week);
    expect(activeView).toMatchObject({
      expedition: {
        playerId: owner,
        expeditionId: first.expeditionId,
        phase: "ACTIVE",
        elapsedMinutes: 30,
        consumedWeekKey: week,
      },
      usedThisWeek: 1,
    });
    expect(await reader.read(owner, "2026-10-26")).toMatchObject({
      expedition: { phase: "ACTIVE", elapsedMinutes: 30 },
      usedThisWeek: 0,
    });
    expect(await reader.read(other, week)).toEqual({ expedition: null, usedThisWeek: 0 });
    expect(await count("solo_expedition_receipts", owner)).toBe(receiptCount);
  });

  it("stages DAY/NIGHT preparation with no quota consumption and replays the same Inbox receipt", async () => {
    const playerId = await trainer();
    const status = new PostgresExpeditionV4StatusReader(pool);
    const first = await store.prepare({
      playerId,
      period: "NIGHT",
      idempotencyKey: "stage-night-private-message-1",
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        expedition: {
          phase: "PREPARING",
          period: "NIGHT",
          elapsedMinutes: 0,
          consumedWeekKey: null,
        },
        consumedWeeklySlot: false,
        replayed: false,
      },
    });
    const second = await store.prepare({
      playerId,
      period: "NIGHT",
      idempotencyKey: "stage-night-private-message-1",
    });
    expect(second).toMatchObject({
      ok: true,
      value: { replayed: true, consumedWeeklySlot: false },
    });
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "stage-night-private-message-1",
      }),
    ).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_INVALID" } });
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "stage-day-private-message-2",
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await status.read(playerId, "2026-10-19")).toMatchObject({
      usedThisWeek: 0,
      expedition: { phase: "PREPARING", period: "NIGHT", elapsedMinutes: 0, consumedWeekKey: null },
    });
    expect(await count("solo_expeditions", playerId)).toBe(1);
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
  });

  it("changes PREPARING period then cancels it with exact durable receipts and no weekly charge", async () => {
    const playerId = await trainer();
    const status = new PostgresExpeditionV4StatusReader(pool);
    const first = await prepare(playerId, "stage-decisions-prepare");
    const edit = {
      playerId,
      expeditionId: first.expeditionId,
      expectedRevision: first.revision,
      period: "NIGHT" as const,
      idempotencyKey: "stage-decisions-period",
    };
    const change = await store.changePeriod(edit);
    expect(change).toMatchObject({
      ok: true,
      value: {
        expedition: { period: "NIGHT", phase: "PREPARING", revision: 1n },
        consumedWeeklySlot: false,
        replayed: false,
      },
    });
    expect(await store.changePeriod(edit)).toMatchObject({
      ok: true,
      value: { replayed: true, consumedWeeklySlot: false },
    });
    expect(await store.changePeriod({ ...edit, period: "DAY" })).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_INVALID" },
    });
    const cancel = {
      playerId,
      expeditionId: first.expeditionId,
      expectedRevision: 1n,
      reason: "CANCELLED" as const,
      idempotencyKey: "stage-decisions-cancel",
    };
    expect(await store.end(cancel)).toMatchObject({
      ok: true,
      value: {
        expedition: { phase: "ENDED", period: "NIGHT", endReason: "CANCELLED" },
        consumedWeeklySlot: false,
        replayed: false,
      },
    });
    expect(await store.end(cancel)).toMatchObject({
      ok: true,
      value: { replayed: true, consumedWeeklySlot: false },
    });
    expect(await store.current(playerId)).toBeNull();
    expect(await status.read(playerId, "2026-10-19")).toEqual({
      usedThisWeek: 0,
      expedition: null,
    });
    expect(await count("solo_expeditions", playerId)).toBe(1);
    expect(await count("solo_expedition_receipts", playerId)).toBe(3);
    const another = await store.prepare({
      playerId,
      period: "DAY",
      idempotencyKey: "stage-decisions-new",
    });
    expect(another).toMatchObject({
      ok: true,
      value: { expedition: { phase: "PREPARING", period: "DAY" }, consumedWeeklySlot: false },
    });
    expect(await status.read(playerId, "2026-10-19")).toMatchObject({ usedThisWeek: 0 });
  });

  it("rejects an ACTIVE but unregistered player before creating a PREPARING receipt", async () => {
    const playerId = createPlayerId();
    await pool.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [playerId]);
    await pool.query("INSERT INTO player_locations(player_id,area_id) VALUES ($1,$2)", [
      playerId,
      activeAreaId,
    ]);
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "unregistered-player",
      }),
    ).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
    expect(await count("solo_expeditions", playerId)).toBe(0);
    expect(await count("solo_expedition_receipts", playerId)).toBe(0);
  });

  it("fails closed if the current area was removed from the ACTIVE PUBLISHED release", async () => {
    const playerId = await trainer(unpublishedAreaId);
    const blocked = await store.prepare({
      playerId,
      period: "DAY",
      idempotencyKey: "unpublished-area",
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await count("solo_expeditions", playerId)).toBe(0);
    expect(await count("solo_expedition_receipts", playerId)).toBe(0);
  });

  it("fails closed if the entire region is inactive in the published release", async () => {
    const playerId = await trainer(inactiveRegionAreaId);
    expect(
      await store.prepare({
        playerId,
        period: "NIGHT",
        idempotencyKey: "unpublished-region",
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await count("solo_expeditions", playerId)).toBe(0);
  });

  it("denies a fully published area outside the V1 solo-expedition scope", async () => {
    const playerId = await trainer(outsideLaunchAreaId);
    const attempt = await store.prepare({
      playerId,
      period: "DAY",
      idempotencyKey: "published-but-outside-launch",
    });
    expect(attempt).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await count("solo_expeditions", playerId)).toBe(0);
    expect(await count("solo_expedition_receipts", playerId)).toBe(0);
  });

  it("fails closed with no published odds: no minutes, weekly charge, outcome or receipt", async () => {
    const playerId = await trainer();
    const exp = await prepare(playerId, "published-search-prepare");
    const encounter = async () => {
      throw new Error("A search lacking a published policy must never create an encounter");
    };
    const search = new PostgresExpeditionV4StagingSearch(
      pool,
      store,
      new PublishedSearchOutcomePolicy(Buffer.alloc(32, 0x27)),
      encounter,
    );
    expect(
      await search.execute({
        playerId,
        expeditionId: exp.expeditionId,
        expectedRevision: exp.revision,
        idempotencyKey: "published-search-no-odds",
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await store.current(playerId)).toMatchObject({
      phase: "PREPARING",
      elapsedMinutes: 0,
      revision: 0n,
      consumedWeekKey: null,
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
    expect(await count("solo_expedition_search_outcomes", playerId)).toBe(0);
  });

  it("proves real PostgreSQL SENT+private+owner+published encounter gating, never pre-send", async () => {
    const playerId = await trainer();
    const expedition = await prepare(playerId, "real-sent-proof-prepare");
    const advanced = await store.advance({
      playerId,
      expeditionId: expedition.expeditionId,
      expectedRevision: expedition.revision,
      minutes: 30,
      idempotencyKey: "real-sent-proof-first-action",
    });
    expect(advanced.ok).toBe(true);

    const content = await pool.query<{ ruleset_id: string }>(
      "SELECT default_ruleset_id AS ruleset_id FROM content_releases WHERE id=$1",
      [publishedReleaseId],
    );
    const rulesetId = content.rows[0]?.ruleset_id;
    expect(rulesetId).toBeDefined();
    const encounterId = randomUUID();
    const outcomeId = randomUUID();
    const outboxMessageId = randomUUID();
    const destinationRef = "5579999999999@s.whatsapp.net";
    await pool.query(
      `INSERT INTO encounters (
        id, player_id, area_id, status, content_release_id, ruleset_id,
        rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
        rng_counter, revision, creation_idempotency_key
      ) VALUES (
        $1, $2, $3, 'CREATED', $4, $5, $6, $7, $8, 1, 0, 0, $9
      )`,
      [
        encounterId,
        playerId,
        activeAreaId,
        publishedReleaseId,
        rulesetId,
        Buffer.alloc(32, 0x31),
        Buffer.alloc(12, 0x32),
        Buffer.alloc(16, 0x33),
        "real-sent-proof-encounter-" + encounterId,
      ],
    );
    await pool.query(
      `INSERT INTO solo_expedition_search_outcomes
        (id, player_id, expedition_id, expedition_revision, kind, encounter_id)
        VALUES ($1,$2,$3,$4,'DIRECT',$5)`,
      [outcomeId, playerId, expedition.expeditionId, expedition.revision.toString(), encounterId],
    );
    await pool.query(
      `INSERT INTO outbox_messages
        (id, channel, message_type, destination_ref, status, sent_at, payload, idempotency_key, correlation_id)
        VALUES ($1, 'whatsapp', 'TEXT', $2, 'PENDING', NULL, $3::jsonb, $4, $5)`,
      [
        outboxMessageId,
        destinationRef,
        JSON.stringify({
          text: "Resultado canônico de busca",
          expeditionSearch: { playerId, encounterId, outcomeId },
        }),
        "real-sent-proof-outbox-" + outboxMessageId,
        randomUUID(),
      ],
    );

    const proof = new PostgresExpeditionSearchSentProof(pool);
    const args = { playerId, encounterId, outcomeId, outboxMessageId, destinationRef };
    expect(await proof.confirm(args)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    // Real schema rejects SENT without a timestamp; do not weaken its CHECK.
    await expect(
      pool.query("UPDATE outbox_messages SET status='SENT' WHERE id=$1", [outboxMessageId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "outbox_messages_check" });
    expect(await proof.confirm(args)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    await pool.query("UPDATE outbox_messages SET status='SENT',sent_at=now() WHERE id=$1", [
      outboxMessageId,
    ]);
    const verified = await proof.confirm(args);
    expect(verified).toMatchObject({
      ok: true,
      value: {
        playerId,
        encounterId,
        outcomeId,
        areaId: activeAreaId,
        encounterRevision: 0n,
        encounterStatus: "CREATED",
      },
    });
    expect(await proof.confirm(args)).toEqual(verified);
    expect(await proof.confirm({ ...args, destinationRef: "120363123456789@g.us" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await proof.confirm({ ...args, destinationRef: "123456789012345@lid" })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(await proof.confirm({ ...args, playerId: await trainer() })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("engages a canonical PG18 Encounter only after a private SENT, with replay and zero battle", async () => {
    const playerId = await trainer();
    const expedition = await prepare(playerId, "real-pg-engagement-prepare");
    expect(
      (
        await store.advance({
          playerId,
          expeditionId: expedition.expeditionId,
          expectedRevision: expedition.revision,
          minutes: 30,
          idempotencyKey: "real-pg-engagement-first-action",
        })
      ).ok,
    ).toBe(true);
    const release = await pool.query<{ ruleset_id: string }>(
      "SELECT default_ruleset_id AS ruleset_id FROM content_releases WHERE id=$1",
      [publishedReleaseId],
    );
    const rulesetId = release.rows[0]?.ruleset_id;
    expect(rulesetId).toBeDefined();
    const encounterId = randomUUID(),
      outcomeId = randomUUID(),
      outboxMessageId = randomUUID();
    const destinationRef = "5579999999999@s.whatsapp.net";
    const snapshot = {
      schemaVersion: 1,
      formId: randomUUID(),
      speciesId: randomUUID(),
      level: 6,
      type1Id: randomUUID(),
      type2Id: null,
      baseStats: { hp: 35, attack: 55, defense: 40, spAttack: 50, spDefense: 50, speed: 90 },
      ivs: { hp: 12, attack: 12, defense: 12, spAttack: 12, spDefense: 12, speed: 12 },
      natureId: randomUUID(),
      abilityId: randomUUID(),
      moves: [{ moveId: randomUUID(), ppCurrent: 35 }],
      maxHp: 19,
      currentHp: 19,
      shiny: false,
      gender: "MALE",
    };
    await pool.query(
      "INSERT INTO encounters(id,player_id,area_id,status,content_release_id,ruleset_id,rng_seed_ciphertext,rng_seed_iv,rng_seed_auth_tag,rng_seed_key_version,rng_counter,revision,creation_idempotency_key) VALUES($1,$2,$3,'PRESENTED',$4,$5,$6,$7,$8,1,0,1,$9)",
      [
        encounterId,
        playerId,
        activeAreaId,
        publishedReleaseId,
        rulesetId,
        Buffer.alloc(32, 0x31),
        Buffer.alloc(12, 0x32),
        Buffer.alloc(16, 0x33),
        "engagement-pg18-" + encounterId,
      ],
    );
    await pool.query(
      "INSERT INTO encounter_snapshots(encounter_id,schema_version,pokemon_snapshot,created_at) VALUES($1,1,$2::jsonb,now())",
      [encounterId, JSON.stringify(snapshot)],
    );
    await pool.query(
      "INSERT INTO encounter_wild_snapshots(encounter_id,wild_no,status,schema_version,pokemon_snapshot,created_at,updated_at) VALUES($1,1,'ACTIVE',1,$2::jsonb,now(),now())",
      [encounterId, JSON.stringify(snapshot)],
    );
    await pool.query(
      "INSERT INTO solo_expedition_search_outcomes(id,player_id,expedition_id,expedition_revision,kind,encounter_id) VALUES($1,$2,$3,$4,'DIRECT',$5)",
      [outcomeId, playerId, expedition.expeditionId, expedition.revision.toString(), encounterId],
    );
    await pool.query(
      "INSERT INTO outbox_messages(id,channel,message_type,destination_ref,status,sent_at,payload,idempotency_key,correlation_id) VALUES($1,'whatsapp','TEXT',$2,'PENDING',NULL,$3::jsonb,$4,$5)",
      [
        outboxMessageId,
        destinationRef,
        JSON.stringify({
          text: "Resultado real de exploração; fixture sem captura",
          expeditionSearch: { playerId, outcomeId, encounterId },
        }),
        "engagement-pg18-outbox-" + outboxMessageId,
        randomUUID(),
      ],
    );
    // observe/engage must never create a new seed or wild Pokemon.
    const encounterService = new EncounterService(
      new PostgresEncounterRepository(pool),
      {
        create: () => {
          throw new Error("Unexpected seed draw");
        },
      },
      clock,
      { enabled: true, reason: null },
    );
    const afterSent = new ExpeditionSearchEngagementAfterSent(
      new PostgresExpeditionSearchSentProof(pool),
      encounterService,
    );
    const proof = { playerId, encounterId, outcomeId, outboxMessageId, destinationRef };
    expect(await afterSent.engageAfterSent(proof)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    const state = async () =>
      (
        await pool.query<{ status: string; revision: string }>(
          "SELECT status, revision::text AS revision FROM encounters WHERE id=$1",
          [encounterId],
        )
      ).rows[0];
    expect(await state()).toMatchObject({ status: "PRESENTED", revision: "1" });
    await pool.query("UPDATE outbox_messages SET status='SENT',sent_at=now() WHERE id=$1", [
      outboxMessageId,
    ]);
    const engaged = await afterSent.engageAfterSent(proof);
    expect(engaged).toMatchObject({
      ok: true,
      value: {
        playerId,
        encounterId,
        areaId: activeAreaId,
        encounterStatus: "ENGAGED",
        encounterRevision: 2n,
      },
    });
    expect(await afterSent.engageAfterSent(proof)).toEqual(engaged);
    expect(await state()).toMatchObject({ status: "ENGAGED", revision: "2" });
    const battles = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM battles WHERE encounter_id=$1",
      [encounterId],
    );
    expect(battles.rows[0]?.n).toBe(0);
  });

  it("observes CREATED and engages the canonical Encounter after SENT, once in the Pokedex", async () => {
    const playerId = await trainer();
    const expedition = await prepare(playerId, "real-pg-created-prepare");
    expect(
      (
        await store.advance({
          playerId,
          expeditionId: expedition.expeditionId,
          expectedRevision: expedition.revision,
          minutes: 30,
          idempotencyKey: "real-pg-created-first-action",
        })
      ).ok,
    ).toBe(true);
    const release = await pool.query<{ ruleset_id: string }>(
      "SELECT default_ruleset_id AS ruleset_id FROM content_releases WHERE id=$1",
      [publishedReleaseId],
    );
    const rulesetId = release.rows[0]?.ruleset_id;
    expect(rulesetId).toBeDefined();
    const encounterId = randomUUID(),
      outcomeId = randomUUID(),
      outboxMessageId = randomUUID();
    const destinationRef = "5579999999999@s.whatsapp.net";
    const speciesId = randomUUID();
    // This is an isolated catalog identity ONLY for PG18 tests, not a
    // published encounter/odds table or an actual game species.
    await pool.query("INSERT INTO pokemon_species(id,national_dex,slug) VALUES($1,$2,$3)", [
      speciesId,
      32000,
      "solo-created-pg-proof-" + speciesId,
    ]);
    const snapshot = {
      schemaVersion: 1,
      formId: randomUUID(),
      speciesId,
      level: 6,
      type1Id: randomUUID(),
      type2Id: null,
      baseStats: { hp: 35, attack: 55, defense: 40, spAttack: 50, spDefense: 50, speed: 90 },
      ivs: { hp: 12, attack: 12, defense: 12, spAttack: 12, spDefense: 12, speed: 12 },
      natureId: randomUUID(),
      abilityId: randomUUID(),
      moves: [{ moveId: randomUUID(), ppCurrent: 35 }],
      maxHp: 19,
      currentHp: 19,
      shiny: false,
      gender: "MALE",
    };
    await pool.query(
      "INSERT INTO encounters(id,player_id,area_id,status,content_release_id,ruleset_id,rng_seed_ciphertext,rng_seed_iv,rng_seed_auth_tag,rng_seed_key_version,rng_counter,revision,creation_idempotency_key) VALUES($1,$2,$3,'CREATED',$4,$5,$6,$7,$8,1,0,0,$9)",
      [
        encounterId,
        playerId,
        activeAreaId,
        publishedReleaseId,
        rulesetId,
        Buffer.alloc(32, 0x31),
        Buffer.alloc(12, 0x32),
        Buffer.alloc(16, 0x33),
        "created-pg18-" + encounterId,
      ],
    );
    await pool.query(
      "INSERT INTO encounter_snapshots(encounter_id,schema_version,pokemon_snapshot,created_at) VALUES($1,1,$2::jsonb,now())",
      [encounterId, JSON.stringify(snapshot)],
    );
    await pool.query(
      "INSERT INTO encounter_wild_snapshots(encounter_id,wild_no,status,schema_version,pokemon_snapshot,created_at,updated_at) VALUES($1,1,'ACTIVE',1,$2::jsonb,now(),now())",
      [encounterId, JSON.stringify(snapshot)],
    );
    await pool.query(
      "INSERT INTO solo_expedition_search_outcomes(id,player_id,expedition_id,expedition_revision,kind,encounter_id) VALUES($1,$2,$3,$4,'DIRECT',$5)",
      [outcomeId, playerId, expedition.expeditionId, expedition.revision.toString(), encounterId],
    );
    await pool.query(
      "INSERT INTO outbox_messages(id,channel,message_type,destination_ref,status,sent_at,payload,idempotency_key,correlation_id) VALUES($1,'whatsapp','TEXT',$2,'PENDING',NULL,$3::jsonb,$4,$5)",
      [
        outboxMessageId,
        destinationRef,
        JSON.stringify({
          text: "Resultado real de exploração; fixture sem captura",
          expeditionSearch: { playerId, outcomeId, encounterId },
        }),
        "created-pg18-outbox-" + outboxMessageId,
        randomUUID(),
      ],
    );
    // observe/engage must never create a new seed or wild Pokemon.
    const encounterService = new EncounterService(
      new PostgresEncounterRepository(pool),
      {
        create: () => {
          throw new Error("Unexpected seed draw");
        },
      },
      clock,
      { enabled: true, reason: null },
    );
    const afterSent = new ExpeditionSearchEngagementAfterSent(
      new PostgresExpeditionSearchSentProof(pool),
      encounterService,
    );
    const proof = { playerId, encounterId, outcomeId, outboxMessageId, destinationRef };
    expect(await afterSent.engageAfterSent(proof)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    const state = async () =>
      (
        await pool.query<{ status: string; revision: string }>(
          "SELECT status, revision::text AS revision FROM encounters WHERE id=$1",
          [encounterId],
        )
      ).rows[0];
    expect(await state()).toMatchObject({ status: "CREATED", revision: "0" });
    await pool.query("UPDATE outbox_messages SET status='SENT',sent_at=now() WHERE id=$1", [
      outboxMessageId,
    ]);
    // Two concurrent worker retries must not increment Pokédex seen twice.
    const [engaged, concurrent] = await Promise.all([
      afterSent.engageAfterSent(proof),
      afterSent.engageAfterSent(proof),
    ]);
    expect(concurrent).toEqual(engaged);
    expect(engaged).toMatchObject({
      ok: true,
      value: {
        playerId,
        encounterId,
        areaId: activeAreaId,
        encounterStatus: "ENGAGED",
        encounterRevision: 2n,
      },
    });
    expect(await afterSent.engageAfterSent(proof)).toEqual(engaged);
    expect(await state()).toMatchObject({ status: "ENGAGED", revision: "2" });
    const seen = await pool.query<{ seen_count: number; caught_count: number }>(
      "SELECT seen_count::int AS seen_count,caught_count::int AS caught_count FROM player_pokedex_species WHERE player_id=$1 AND species_id=$2",
      [playerId, speciesId],
    );
    expect(seen.rows).toMatchObject([{ seen_count: 1, caught_count: 0 }]);
    const battles = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM battles WHERE encounter_id=$1",
      [encounterId],
    );
    expect(battles.rows[0]?.n).toBe(0);
  });

  it("verifies the durable search outcome before returning a receipt and never rerolls a replay", async () => {
    const playerId = await trainer();
    const exp = await prepare(playerId, "stage-outcome-prepare");
    let decisions = 0;
    const search = new PostgresExpeditionV4StagingSearch(
      pool,
      store,
      {
        decide: async () => {
          decisions++;
          return ok({ kind: "NO_SIGNAL" as const });
        },
      },
      async () => {
        throw new Error("No encounter must be emitted for a test-only NO_SIGNAL outcome");
      },
    );
    const input = {
      playerId,
      expeditionId: exp.expeditionId,
      expectedRevision: exp.revision,
      idempotencyKey: "stage-outcome-first",
    };
    const first = await search.execute(input);
    expect(first).toMatchObject({
      ok: true,
      value: {
        transition: {
          consumedWeeklySlot: true,
          replayed: false,
          expedition: { phase: "ACTIVE", elapsedMinutes: 30, revision: 1n },
        },
        outcome: {
          playerId,
          expeditionId: exp.expeditionId,
          kind: "NO_SIGNAL",
          encounterId: null,
          expeditionRevision: 0n,
        },
        encounterPreview: null,
      },
    });
    const again = await search.execute(input);
    expect(again).toMatchObject({ ok: true, value: { transition: { replayed: true } } });
    if (first.ok && again.ok)
      expect(again.value.outcome.outcomeId).toBe(first.value.outcome.outcomeId);
    expect(decisions).toBe(1);
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
    expect(await count("solo_expedition_search_outcomes", playerId)).toBe(1);
    expect((await store.current(playerId))?.elapsedMinutes).toBe(30);
  });

  it("persists NO_SIGNAL then TRAIL, charges once weekly and returns exact result on replay", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "outcome-prepare");
    let called = 0;
    const outcome = (kind: "NO_SIGNAL" | "TRAIL") =>
      createSearchOutcomeEffect({
        policy: {
          decide: async () => {
            called++;
            return ok({ kind });
          },
        },
        encounter: async () => {
          throw new Error("Non-encounter results must never invoke EncounterService");
        },
      });
    const first = await store.executeSearchFree({
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      idempotencyKey: "outcome-no-signal",
      effect: outcome("NO_SIGNAL"),
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: true,
        expedition: { elapsedMinutes: 30, revision: 1n },
      },
    });
    if (!first.ok) return;
    expect(
      await store.executeSearchFree({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 0n,
        idempotencyKey: "outcome-no-signal",
        effect: outcome("NO_SIGNAL"),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        effectRef: first.value.effectRef,
      },
    });
    const second = await store.executeSearchFree({
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 1n,
      idempotencyKey: "outcome-trail",
      effect: outcome("TRAIL"),
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: false,
        expedition: { elapsedMinutes: 60, revision: 2n },
      },
    });
    expect(called).toBe(2);
    if (!second.ok) return;
    const client = await pool.connect();
    try {
      const noSignal = await readStoredSearchOutcome(client, playerId, first.value.effectRef);
      const trail = await readStoredSearchOutcome(client, playerId, second.value.effectRef);
      expect(noSignal).toMatchObject({
        playerId,
        expeditionId: initial.expeditionId,
        expeditionRevision: 0n,
        kind: "NO_SIGNAL",
        encounterId: null,
      });
      expect(trail).toMatchObject({
        playerId,
        expeditionId: initial.expeditionId,
        expeditionRevision: 1n,
        kind: "TRAIL",
        encounterId: null,
      });
      expect(
        await readStoredSearchOutcome(client, createPlayerId(), second.value.effectRef),
      ).toBeNull();
    } finally {
      client.release();
    }
    const rows = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM solo_expedition_search_outcomes WHERE player_id=$1",
      [playerId],
    );
    expect(rows.rows[0]?.n).toBe("2");
    expect(await count("solo_expedition_receipts", playerId)).toBe(3);
  });

  it("rejects an invalid server outcome without burning any time or creating a receipt", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "outcome-invalid-prepare");
    const effect = createSearchOutcomeEffect({
      policy: {
        decide: async () => ok({ kind: "UNKNOWN" as "DIRECT" }),
      },
      encounter: async () => {
        throw new Error("Encounter must not run");
      },
    });
    expect(
      await store.executeSearchFree({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 0n,
        idempotencyKey: "outcome-invalid",
        effect,
      }),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    expect(await store.current(playerId)).toMatchObject({
      phase: "PREPARING",
      elapsedMinutes: 0,
      consumedWeekKey: null,
      revision: 0n,
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
    expect(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM solo_expedition_search_outcomes WHERE player_id=$1",
          [playerId],
        )
      ).rows[0]?.n,
    ).toBe("0");
  });

  it("commits effect, 30 minutes, quota and durable receipt atomically, then replays", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "atomic-search-prepare");
    let effectCount = 0;
    const effectId = randomUUID();
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      idempotencyKey: "atomic-search-one",
      effect: async (client: import("pg").PoolClient) => {
        effectCount++;
        await client.query(
          "INSERT INTO solo_search_effect_test(id,player_id,expedition_id) VALUES ($1,$2,$3)",
          [effectId, playerId, initial.expeditionId],
        );
        return ok({ effectRef: effectId });
      },
    };
    const first = await store.executeSearchFree(input);
    expect(first).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        effectRef: effectId,
        consumedWeeklySlot: true,
        expedition: {
          phase: "ACTIVE",
          elapsedMinutes: 30,
          revision: 1n,
          consumedWeekKey: "2026-10-19",
        },
      },
    });
    expect(await store.executeSearchFree(input)).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        effectRef: effectId,
        expedition: { revision: 1n, elapsedMinutes: 30 },
      },
    });
    expect(effectCount).toBe(1);
    expect(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM solo_search_effect_test WHERE player_id=$1",
          [playerId],
        )
      ).rows[0]?.n,
    ).toBe("1");
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
  });

  it("rolls back a partially written search when canonical effect refuses", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "atomic-reject-prepare");
    const attemptedId = randomUUID();
    const common = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      idempotencyKey: "atomic-reject",
    };
    const rejected = await store.executeSearchFree({
      ...common,
      effect: async (client) => {
        await client.query(
          "INSERT INTO solo_search_effect_test(id,player_id,expedition_id) VALUES ($1,$2,$3)",
          [attemptedId, playerId, initial.expeditionId],
        );
        return err(appError("FLOW_BLOCKED", "Encounter catalog is unavailable"));
      },
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await store.current(playerId)).toMatchObject({
      phase: "PREPARING",
      elapsedMinutes: 0,
      consumedWeekKey: null,
      revision: 0n,
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
    expect(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM solo_search_effect_test WHERE player_id=$1",
          [playerId],
        )
      ).rows[0]?.n,
    ).toBe("0");

    // Failed input did not consume its idempotency key: a legitimate retry may commit.
    const retried = await store.executeSearchFree({
      ...common,
      effect: async (client) => {
        await client.query(
          "INSERT INTO solo_search_effect_test(id,player_id,expedition_id) VALUES ($1,$2,$3)",
          [attemptedId, playerId, initial.expeditionId],
        );
        return ok({ effectRef: attemptedId });
      },
    });
    expect(retried).toMatchObject({
      ok: true,
      value: {
        effectRef: attemptedId,
        consumedWeeklySlot: true,
      },
    });
  });

  it("rolls back SQL side effects and quota when an encounter throws unexpectedly", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "atomic-throw-prepare");
    const evidenceId = randomUUID();
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      idempotencyKey: "atomic-throw-command",
    };
    await expect(
      store.executeSearchFree({
        ...input,
        effect: async (client) => {
          await client.query(
            "INSERT INTO solo_search_effect_test(id,player_id,expedition_id) VALUES ($1,$2,$3)",
            [evidenceId, playerId, initial.expeditionId],
          );
          throw new Error("synthetic failed encounter generation");
        },
      }),
    ).rejects.toThrow("synthetic failed encounter generation");
    expect(await store.current(playerId)).toMatchObject({
      phase: "PREPARING",
      revision: 0n,
      elapsedMinutes: 0,
      consumedWeekKey: null,
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
    expect(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM solo_search_effect_test WHERE player_id=$1",
          [playerId],
        )
      ).rows[0]?.n,
    ).toBe("0");
    expect(
      await store.executeSearchFree({
        ...input,
        effect: async (client) => {
          await client.query(
            "INSERT INTO solo_search_effect_test(id,player_id,expedition_id) VALUES ($1,$2,$3)",
            [evidenceId, playerId, initial.expeditionId],
          );
          return ok({ effectRef: evidenceId });
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: true,
        effectRef: evidenceId,
      },
    });
  });

  it("blocks invalid evidence and mismatched reused action keys without losing quota", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "atomic-evidence-prepare");
    const common = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      idempotencyKey: "atomic-evidence",
    };
    expect(
      await store.executeSearchFree({
        ...common,
        effect: async () => ok({ effectRef: "" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await store.current(playerId)).toMatchObject({
      phase: "PREPARING",
      consumedWeekKey: null,
      elapsedMinutes: 0,
    });
    const succeeded = await store.executeSearchFree({
      ...common,
      effect: async () => ok({ effectRef: "encounter:test-evidence" }),
    });
    expect(succeeded.ok).toBe(true);
    expect(
      await store.executeSearchFree({
        ...common,
        expectedRevision: 1n,
        effect: async () => {
          throw new Error("Effect must not execute after key reuse");
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_INVALID" } });
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
  });

  it("serializes parallel delivery of the same search and never duplicates its effect", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "atomic-race-prepare");
    const effectId = randomUUID();
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      idempotencyKey: "atomic-race-search",
      effect: async (client: import("pg").PoolClient) => {
        await client.query(
          "INSERT INTO solo_search_effect_test(id,player_id,expedition_id) VALUES ($1,$2,$3)",
          [effectId, playerId, initial.expeditionId],
        );
        return ok({ effectRef: effectId });
      },
    };
    const results = await Promise.all([
      store.executeSearchFree(input),
      store.executeSearchFree(input),
      store.executeSearchFree(input),
      store.executeSearchFree(input),
    ]);
    expect(results.filter((x) => x.ok && !x.value.replayed)).toHaveLength(1);
    expect(results.filter((x) => x.ok && x.value.replayed)).toHaveLength(3);
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
    expect(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM solo_search_effect_test WHERE player_id=$1",
          [playerId],
        )
      ).rows[0]?.n,
    ).toBe("1");
  });

  it("denies a search when World location changes after preparation", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "atomic-location-prepare");
    await pool.query("UPDATE player_locations SET area_id=$1 WHERE player_id=$2", [
      outsideLaunchAreaId,
      playerId,
    ]);
    const blocked = await store.executeSearchFree({
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      idempotencyKey: "atomic-drift",
      effect: async () => {
        throw new Error("No effect allowed after World drift");
      },
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await store.current(playerId)).toMatchObject({
      phase: "PREPARING",
      elapsedMinutes: 0,
      consumedWeekKey: null,
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
  });

  it("persists free preparation and restores its location after reconstruction", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "init");
    expect(initial).toMatchObject({
      phase: "PREPARING",
      elapsedMinutes: 0,
      consumedWeekKey: null,
      revision: 0n,
    });
    const reloaded = new PostgresExpeditionRepository(pool, clock, "America/Maceio");
    expect(await reloaded.current(playerId)).toEqual(initial);
    expect(await count("solo_expeditions", playerId)).toBe(1);
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
  });

  it("persists a free NIGHT switch, replays one receipt and charges no quota", async () => {
    const playerId = await trainer();
    const expedition = await prepare(playerId, "period-prepare");
    const input = {
      playerId,
      expeditionId: expedition.expeditionId,
      expectedRevision: 0n,
      period: "NIGHT" as const,
      idempotencyKey: "period-one",
    };
    const switched = await store.changePeriod(input);
    expect(switched).toMatchObject({
      ok: true,
      value: {
        changed: true,
        replayed: false,
        consumedWeeklySlot: false,
        expedition: {
          period: "NIGHT",
          phase: "PREPARING",
          elapsedMinutes: 0,
          consumedWeekKey: null,
          revision: 1n,
        },
      },
    });
    expect((await store.current(playerId))?.period).toBe("NIGHT");
    expect(await store.changePeriod(input)).toMatchObject({
      ok: true,
      value: { replayed: true, expedition: { revision: 1n, period: "NIGHT" } },
    });
    expect(await store.changePeriod({ ...input, period: "DAY" })).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_INVALID" },
    });
    expect(await store.changePeriod({ ...input, idempotencyKey: "period-stale" })).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
    const started = await store.advance({
      playerId,
      expeditionId: expedition.expeditionId,
      expectedRevision: 1n,
      minutes: 30,
      idempotencyKey: "period-start",
    });
    expect(started).toMatchObject({
      ok: true,
      value: { consumedWeeklySlot: true, expedition: { phase: "ACTIVE", period: "NIGHT" } },
    });
    expect(
      await store.changePeriod({
        ...input,
        expectedRevision: 2n,
        idempotencyKey: "period-too-late",
        period: "DAY",
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("serializes two racing period changes and deduplicates a retry", async () => {
    const playerId = await trainer();
    const expedition = await prepare(playerId, "race-period-prepare");
    const base = {
      playerId,
      expeditionId: expedition.expeditionId,
      expectedRevision: 0n,
      period: "NIGHT" as const,
    };
    const results = await Promise.all([
      store.changePeriod({ ...base, idempotencyKey: "race-period-A" }),
      store.changePeriod({ ...base, idempotencyKey: "race-period-B" }),
    ]);
    expect(results.filter((result) => result.ok && !result.value.replayed)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.error.code === "REVISION_CONFLICT"),
    ).toHaveLength(1);
    const current = await store.current(playerId);
    expect(current).toMatchObject({
      period: "NIGHT",
      phase: "PREPARING",
      revision: 1n,
      consumedWeekKey: null,
      elapsedMinutes: 0,
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
  });

  it("reserves one weekly slot and rejects altered replays", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "once-start");
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      minutes: 30,
      idempotencyKey: "once-action",
    };
    const first = await store.advance(input);
    expect(first).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        consumedWeeklySlot: true,
        expedition: { revision: 1n, consumedWeekKey: "2026-10-19" },
      },
    });
    expect(await store.advance(input)).toMatchObject({
      ok: true,
      value: { replayed: true, expedition: { elapsedMinutes: 30 } },
    });
    expect(await store.advance({ ...input, minutes: 60 })).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_INVALID" },
    });
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "once-start",
      }),
    ).toMatchObject({
      ok: true,
      value: { replayed: true, expedition: { phase: "PREPARING" } },
    });
    expect((await store.current(playerId))?.revision).toBe(1n);
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
  });

  it("serializes simultaneous distinct commands and rejects the stale revision", async () => {
    const playerId = await trainer();
    const original = await prepare(playerId, "race-prepare");
    const input = {
      playerId,
      expeditionId: original.expeditionId,
      expectedRevision: 0n,
      minutes: 30,
    };
    const results = await Promise.all([
      store.advance({ ...input, idempotencyKey: "race-one" }),
      store.advance({ ...input, idempotencyKey: "race-two" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { ok: false, error: { code: "REVISION_CONFLICT" } },
    ]);
    expect((await store.current(playerId))?.elapsedMinutes).toBe(30);
  });

  it("deduplicates concurrent delivery of the exact same WhatsApp action", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "dup-prepare");
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      minutes: 30,
      idempotencyKey: "same-inbox",
    };
    const results = await Promise.all([store.advance(input), store.advance(input)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.value.replayed)).toHaveLength(1);
    expect((await store.current(playerId))?.revision).toBe(1n);
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
  });

  it("blocks the fourth expédition and resets on the local Monday", async () => {
    const playerId = await trainer();
    for (let index = 0; index < 3; index += 1) {
      const initial = await prepare(playerId, "weekly-prepare-" + index);
      const advanced = await store.advance({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 0n,
        minutes: 30,
        idempotencyKey: "weekly-start-" + index,
      });
      expect(advanced.ok).toBe(true);
      const completed = await store.end({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 1n,
        reason: "VOLUNTARY",
        idempotencyKey: "weekly-end-" + index,
      });
      expect(completed).toMatchObject({
        ok: true,
        value: { expedition: { phase: "ENDED" } },
      });
    }
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "weekly-fourth",
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    clock.advanceMs(6 * 24 * 60 * 60 * 1000 + 15 * 60 * 60 * 1000);
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "weekly-next",
      }),
    ).toMatchObject({ ok: true, value: { expedition: { phase: "PREPARING" } } });
  });

  it("continues across weekly reset without consuming an additional slot", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "carry-prepare");
    const started = await store.advance({
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      minutes: 30,
      idempotencyKey: "carry-first",
    });
    expect(started.ok).toBe(true);
    clock.advanceMs(7 * 24 * 60 * 60 * 1000);
    expect(
      await store.advance({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 1n,
        minutes: 15,
        idempotencyKey: "carry-second",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: false,
        expedition: { elapsedMinutes: 45, consumedWeekKey: "2026-10-26" },
      },
    });
  });

  it("cancels without a slot and persists an ended blackout", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "cancel-prepare");
    expect(
      await store.end({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 0n,
        reason: "CANCELLED",
        idempotencyKey: "cancel-end",
      }),
    ).toMatchObject({
      ok: true,
      value: { expedition: { phase: "ENDED", consumedWeekKey: null } },
    });
    expect(await store.current(playerId)).toBeNull();
    const next = await prepare(playerId, "blackout-prepare");
    expect(
      (
        await store.advance({
          playerId,
          expeditionId: next.expeditionId,
          expectedRevision: 0n,
          minutes: 30,
          idempotencyKey: "blackout-first",
        })
      ).ok,
    ).toBe(true);
    expect(
      await store.end({
        playerId,
        expeditionId: next.expeditionId,
        expectedRevision: 1n,
        reason: "BLACKOUT",
        idempotencyKey: "blackout-end",
      }),
    ).toMatchObject({
      ok: true,
      value: { expedition: { phase: "ENDED", endReason: "BLACKOUT" } },
    });
  });

  it("does not write failed actions or stale commands into the ledger", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "invalid-prepare");
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      minutes: 721,
      idempotencyKey: "invalid-length",
    };
    expect(await store.advance(input)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(
      await store.advance({
        ...input,
        expectedRevision: 4n,
        minutes: 30,
        idempotencyKey: "invalid-stale",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
    expect((await store.current(playerId))?.revision).toBe(0n);
  });

  it("runs the REAL OutboxWorker post-SENT hook in isolated PG18, preserving Pokédex", async () => {
    const playerId = await trainer();
    const expedition = await prepare(playerId, "real-worker-created-prepare");
    expect(
      (
        await store.advance({
          playerId,
          expeditionId: expedition.expeditionId,
          expectedRevision: expedition.revision,
          minutes: 30,
          idempotencyKey: "real-worker-created-first-action",
        })
      ).ok,
    ).toBe(true);
    const release = await pool.query<{ ruleset_id: string }>(
      "SELECT default_ruleset_id AS ruleset_id FROM content_releases WHERE id=$1",
      [publishedReleaseId],
    );
    const rulesetId = release.rows[0]?.ruleset_id;
    expect(rulesetId).toBeDefined();
    const encounterId = randomUUID(),
      outcomeId = randomUUID(),
      outboxMessageId = randomUUID();
    const destinationRef = "5579999999999@s.whatsapp.net";
    const speciesId = randomUUID();
    // This is an isolated catalog identity ONLY for PG18 tests, not a
    // published encounter/odds table or an actual game species.
    await pool.query("INSERT INTO pokemon_species(id,national_dex,slug) VALUES($1,$2,$3)", [
      speciesId,
      32001,
      "solo-created-pg-proof-" + speciesId,
    ]);
    const snapshot = {
      schemaVersion: 1,
      formId: randomUUID(),
      speciesId,
      level: 6,
      type1Id: randomUUID(),
      type2Id: null,
      baseStats: { hp: 35, attack: 55, defense: 40, spAttack: 50, spDefense: 50, speed: 90 },
      ivs: { hp: 12, attack: 12, defense: 12, spAttack: 12, spDefense: 12, speed: 12 },
      natureId: randomUUID(),
      abilityId: randomUUID(),
      moves: [{ moveId: randomUUID(), ppCurrent: 35 }],
      maxHp: 19,
      currentHp: 19,
      shiny: false,
      gender: "MALE",
    };
    await pool.query(
      "INSERT INTO encounters(id,player_id,area_id,status,content_release_id,ruleset_id,rng_seed_ciphertext,rng_seed_iv,rng_seed_auth_tag,rng_seed_key_version,rng_counter,revision,creation_idempotency_key) VALUES($1,$2,$3,'CREATED',$4,$5,$6,$7,$8,1,0,0,$9)",
      [
        encounterId,
        playerId,
        activeAreaId,
        publishedReleaseId,
        rulesetId,
        Buffer.alloc(32, 0x31),
        Buffer.alloc(12, 0x32),
        Buffer.alloc(16, 0x33),
        "worker-created-pg18-" + encounterId,
      ],
    );
    await pool.query(
      "INSERT INTO encounter_snapshots(encounter_id,schema_version,pokemon_snapshot,created_at) VALUES($1,1,$2::jsonb,now())",
      [encounterId, JSON.stringify(snapshot)],
    );
    await pool.query(
      "INSERT INTO encounter_wild_snapshots(encounter_id,wild_no,status,schema_version,pokemon_snapshot,created_at,updated_at) VALUES($1,1,'ACTIVE',1,$2::jsonb,now(),now())",
      [encounterId, JSON.stringify(snapshot)],
    );
    await pool.query(
      "INSERT INTO solo_expedition_search_outcomes(id,player_id,expedition_id,expedition_revision,kind,encounter_id) VALUES($1,$2,$3,$4,'DIRECT',$5)",
      [outcomeId, playerId, expedition.expeditionId, expedition.revision.toString(), encounterId],
    );
    await pool.query(
      "INSERT INTO outbox_messages(id,channel,message_type,destination_ref,status,sent_at,payload,idempotency_key,correlation_id) VALUES($1,'whatsapp','TEXT',$2,'PENDING',NULL,$3::jsonb,$4,$5)",
      [
        outboxMessageId,
        destinationRef,
        JSON.stringify({
          text: "Resultado real de exploração; fixture sem captura",
          expeditionSearch: { playerId, outcomeId, encounterId },
        }),
        "worker-created-pg18-outbox-" + outboxMessageId,
        randomUUID(),
      ],
    );
    // observe/engage must never create a new seed or wild Pokemon.
    const encounterService = new EncounterService(
      new PostgresEncounterRepository(pool),
      {
        create: () => {
          throw new Error("Unexpected seed draw");
        },
      },
      clock,
      { enabled: true, reason: null },
    );
    const afterSent = new ExpeditionSearchEngagementAfterSent(
      new PostgresExpeditionSearchSentProof(pool),
      encounterService,
    );
    const proof = { playerId, encounterId, outcomeId, outboxMessageId, destinationRef };
    expect(await afterSent.engageAfterSent(proof)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    const state = async () =>
      (
        await pool.query<{ status: string; revision: string }>(
          "SELECT status, revision::text AS revision FROM encounters WHERE id=$1",
          [encounterId],
        )
      ).rows[0];
    expect(await state()).toMatchObject({ status: "CREATED", revision: "0" });
    const quoteResolver = new PostgresExpeditionQuotedEncounterProof(pool);
    const quoted = {
      provider: "baileys",
      playerId,
      senderRef: destinationRef,
      chatRef: destinationRef,
      replyToExternalMessageId: outboxMessageId.replaceAll("-", "").toUpperCase(),
    };
    // A provider-looking quote MUST NOT authorize an encounter while PENDING.
    expect(await quoteResolver.resolve(quoted)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    // Real OutboxWorker + real PostgresMessagingRepository; the provider is a
    // synthetic transport isolated from WhatsApp/Baileys and the live database.
    // markOutboxSent must commit BEFORE the callback verifies its proof.
    const delivered: string[] = [];
    const failures: string[] = [];
    const hook = new ExpeditionSearchPostSentHook(afterSent, ({ errorCode }) => {
      failures.push(errorCode);
    });
    const worker = new OutboxWorker(
      new PostgresMessagingRepository(pool),
      [
        {
          channel: "whatsapp",
          send: async (outgoing) => {
            delivered.push(outgoing.id);
            return { providerExternalMessageId: "isolated-pg18-only" };
          },
        },
      ],
      {
        batchSize: 100,
        staleAfterMs: 30_000,
        maxAttempts: 8,
        baseBackoffMs: 1_000,
        maxBackoffMs: 60_000,
      },
      undefined,
      hook,
    );
    const delivery = await worker.runOnce();
    expect(delivered).toContain(outboxMessageId);
    expect(delivery.sent).toBeGreaterThan(0);
    expect(delivery.failed).toBe(0);
    expect(failures).not.toContain("EXPEDITION_POST_SENT_FLOW_BLOCKED");
    // Worker already advanced it. Concurrent replay still has zero duplicate
    // Pokédex/capture/battle side-effects.
    const [engaged, concurrent] = await Promise.all([
      afterSent.engageAfterSent(proof),
      afterSent.engageAfterSent(proof),
    ]);
    expect(concurrent).toEqual(engaged);
    expect(engaged).toMatchObject({
      ok: true,
      value: {
        playerId,
        encounterId,
        areaId: activeAreaId,
        encounterStatus: "ENGAGED",
        encounterRevision: 2n,
      },
    });
    expect(await afterSent.engageAfterSent(proof)).toEqual(engaged);
    expect(await state()).toMatchObject({ status: "ENGAGED", revision: "2" });
    // New SQL exercised against actual disposable PG18, not mocked query rows.
    expect(await quoteResolver.resolve(quoted)).toEqual(
      ok({ playerId, outcomeId, encounterId, encounterRevision: 2n }),
    );
    // Actual PG18 canonical EncounterOperationalReadService participates in the
    // same staging-only quoted reply flow; identity mapping is synthetic here.
    const stagingReply = new ExpeditionQuotedReplyReadOnlyStagingResolver(
      {
        async resolvePlayer() {
          return ok({ playerId, state: "COMPLETE" as const, created: false });
        },
      } as unknown as ConstructorParameters<typeof ExpeditionQuotedReplyReadOnlyStagingResolver>[0],
      quoteResolver,
      new EncounterOperationalReadService(new PostgresEncounterRepository(pool)),
      new PostgresExpeditionIssuedMenuReplyProof(pool),
    );
    const replyContext: MessageHandlerContext = {
      inboxMessageId: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
      idempotencyKey: "inbox:baileys:pg18-quoted-readonly",
      message: {
        provider: "baileys",
        externalMessageId: randomUUID(),
        senderRef: destinationRef,
        chatRef: destinationRef,
        occurredAt: "2026-11-01T23:35:00.000Z",
        text: "2",
        replyToExternalMessageId: quoted.replyToExternalMessageId,
        mediaRefs: [],
      },
    };
    // A canonical SENT quote *without* an issued menu is deliberately inert.
    expect(await stagingReply.resolve(replyContext)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    // Issued menu receipt is immutable, binds provider quote to exact Ball
    // IDs and must never authorize a reply when a newer delivered menu exists.
    const menuProof = new PostgresExpeditionIssuedMenuReplyProof(pool);
    const menuId = randomUUID();
    const eligibleBallItemId = randomUUID();
    await pool.query(
      `INSERT INTO solo_incidental_menu_snapshots(
         id,player_id,outcome_id,encounter_id,encounter_revision,panel,ball_item_ids
       ) VALUES($1,$2,$3,$4,2,$5::jsonb,$6::jsonb)`,
      [
        menuId,
        playerId,
        outcomeId,
        encounterId,
        JSON.stringify({ text: "synthetic menu, not sent by live WhatsApp" }),
        JSON.stringify({ "2": eligibleBallItemId }),
      ],
    );
    await pool.query(
      `INSERT INTO solo_incidental_menu_deliveries(
         id,menu_id,player_id,provider,chat_ref,external_message_id
       ) VALUES($1,$2,$3,'baileys',$4,$5)`,
      [randomUUID(), menuId, playerId, destinationRef, quoted.replyToExternalMessageId],
    );
    expect(await menuProof.resolve(quoted)).toEqual(
      ok({
        menuId,
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": eligibleBallItemId },
      }),
    );
    const issuedReply = await stagingReply.resolve(replyContext);
    expect(issuedReply).toMatchObject({
      ok: true,
      value: { resultRefId: null, resultRefType: null },
    });
    if (issuedReply.ok && issuedReply.value !== null) {
      expect(issuedReply.value.outgoing).toHaveLength(1);
      expect(issuedReply.value.outgoing[0]?.destinationRef).toBe(destinationRef);
      expect(String(issuedReply.value.outgoing[0]?.payload.text)).toContain(
        "sem executar nenhuma ação",
      );
    }
    const nextOutcomeId = randomUUID();
    const nextMenuId = randomUUID();
    const nextOutboxId = randomUUID();
    const nextBallId = randomUUID();
    await pool.query(
      `INSERT INTO solo_expedition_search_outcomes(
         id,player_id,expedition_id,expedition_revision,kind,encounter_id
       ) VALUES($1,$2,$3,1,'DIRECT',$4)`,
      [nextOutcomeId, playerId, expedition.expeditionId, encounterId],
    );
    await pool.query(
      `INSERT INTO solo_incidental_menu_snapshots(
         id,player_id,outcome_id,encounter_id,encounter_revision,panel,ball_item_ids
       ) VALUES($1,$2,$3,$4,2,$5::jsonb,$6::jsonb)`,
      [
        nextMenuId,
        playerId,
        nextOutcomeId,
        encounterId,
        JSON.stringify({ text: "newer immutable menu" }),
        JSON.stringify({ "2": nextBallId }),
      ],
    );
    // An un-delivered newer menu cannot invalidate the last usable menu.
    expect((await menuProof.resolve(quoted)).ok).toBe(true);
    await pool.query(
      `INSERT INTO outbox_messages(
         id,channel,message_type,destination_ref,status,sent_at,
         payload,idempotency_key,correlation_id
       ) VALUES($1,'whatsapp','TEXT',$2,'SENT',now(),$3::jsonb,$4,$5)`,
      [
        nextOutboxId,
        destinationRef,
        JSON.stringify({
          text: "newer menu staging-only",
          expeditionSearch: { playerId, outcomeId: nextOutcomeId, encounterId },
        }),
        "newer-menu-pg18-" + nextOutboxId,
        randomUUID(),
      ],
    );
    await pool.query(
      `INSERT INTO solo_incidental_menu_deliveries(
         id,menu_id,player_id,provider,chat_ref,external_message_id
       ) VALUES($1,$2,$3,'baileys',$4,$5)`,
      [
        randomUUID(),
        nextMenuId,
        playerId,
        destinationRef,
        nextOutboxId.replaceAll("-", "").toUpperCase(),
      ],
    );
    expect(await menuProof.resolve(quoted)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(await stagingReply.resolve(replyContext)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(
      await menuProof.resolve({
        ...quoted,
        replyToExternalMessageId: nextOutboxId.replaceAll("-", "").toUpperCase(),
      }),
    ).toEqual(
      ok({
        menuId: nextMenuId,
        playerId,
        outcomeId: nextOutcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": nextBallId },
      }),
    );
    // The real staging issuer derives choices from real inventory and stages
    // the Outbox, immutable menu snapshot and Baileys reply link atomically.
    const issuedOutcomeId = randomUUID();
    const issuedSourceId = randomUUID();
    const availableBallId = publishedBallItemId;
    await pool.query("INSERT INTO inventory_balances(player_id,item_id,quantity) VALUES($1,$2,3)", [
      playerId,
      availableBallId,
    ]);
    await pool.query(
      `INSERT INTO solo_expedition_search_outcomes(
         id,player_id,expedition_id,expedition_revision,kind,encounter_id
       ) VALUES($1,$2,$3,2,'DIRECT',$4)`,
      [issuedOutcomeId, playerId, expedition.expeditionId, encounterId],
    );
    await pool.query(
      `INSERT INTO outbox_messages(
         id,channel,message_type,destination_ref,status,sent_at,
         payload,idempotency_key,correlation_id
       ) VALUES($1,'whatsapp','TEXT',$2,'SENT',now(),$3::jsonb,$4,$5)`,
      [
        issuedSourceId,
        destinationRef,
        JSON.stringify({
          text: "Published encounter search, actual provider read-only",
          expeditionSearch: { playerId, outcomeId: issuedOutcomeId, encounterId },
        }),
        "published-source-menu-pg18-" + issuedSourceId,
        randomUUID(),
      ],
    );
    const issuer = new PostgresExpeditionReadOnlyMenuIssuer(pool);
    const issuedInput = {
      playerId,
      outcomeId: issuedOutcomeId,
      encounterId,
      expectedEncounterRevision: 2n,
      destinationRef,
      correlationId: randomUUID(),
    };
    const actualMenu = await issuer.issue(issuedInput);
    expect(actualMenu).toMatchObject({
      ok: true,
      value: { replayed: false, ballItemIds: { "2": availableBallId } },
    });
    if (!actualMenu.ok) throw new Error("Read-only menu issuer declined verified PG18 encounter");
    expect(actualMenu.value.text).toContain("Poké Ball ×3");
    expect(actualMenu.value.text).toContain("Nenhuma escolha executa captura");
    const persistedBeforeSend = await pool.query<{
      status: string;
      id: string;
    }>("SELECT id::text,status FROM outbox_messages WHERE id=$1", [
      actualMenu.value.outboxMessageId,
    ]);
    expect(persistedBeforeSend.rows).toMatchObject([{ status: "PENDING" }]);
    const issuedQuote = {
      ...quoted,
      replyToExternalMessageId: actualMenu.value.outboxMessageId.replaceAll("-", "").toUpperCase(),
    };
    expect(await menuProof.resolve(issuedQuote)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    const preparedReplay = await issuer.issue(issuedInput);
    expect(preparedReplay).toEqual(ok({ ...actualMenu.value, replayed: true }));
    // No duplicate Outbox; first success is exactly once across replays.
    expect(
      (
        await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM outbox_messages WHERE idempotency_key=$1",
          ["exploration-issued-menu:" + issuedOutcomeId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    await pool.query("UPDATE outbox_messages SET status='SENT',sent_at=now() WHERE id=$1", [
      actualMenu.value.outboxMessageId,
    ]);
    expect(await menuProof.resolve(issuedQuote)).toEqual(
      ok({
        menuId: actualMenu.value.menuId,
        playerId,
        outcomeId: issuedOutcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": availableBallId },
      }),
    );
    // A changed live balance must never silently remap the *issued* menu.
    await pool.query("UPDATE inventory_balances SET quantity=0 WHERE player_id=$1 AND item_id=$2", [
      playerId,
      availableBallId,
    ]);
    expect(await issuer.issue(issuedInput)).toEqual(preparedReplay);

    // Two adversarial PostgreSQL 18 proofs, not mocked repositories:
    // 1) parallel first-issue requests may create one immutable menu only;
    // 2) a transport queue INSERT failure rolls back snapshot and binding.
    const eligibleNewOutcome = async (revision: number) => {
      const outcome = randomUUID();
      const source = randomUUID();
      await pool.query(
        `INSERT INTO solo_expedition_search_outcomes(
           id,player_id,expedition_id,expedition_revision,kind,encounter_id
         ) VALUES($1,$2,$3,$4,'DIRECT',$5)`,
        [outcome, playerId, expedition.expeditionId, revision, encounterId],
      );
      await pool.query(
        `INSERT INTO outbox_messages(
           id,channel,message_type,destination_ref,status,sent_at,
           payload,idempotency_key,correlation_id
         ) VALUES($1,'whatsapp','TEXT',$2,'SENT',now(),$3::jsonb,$4,$5)`,
        [
          source,
          destinationRef,
          JSON.stringify({
            text: "Published search result for menu transaction proof",
            expeditionSearch: { playerId, outcomeId: outcome, encounterId },
          }),
          "menu-transaction-source-pg18-" + source,
          randomUUID(),
        ],
      );
      return {
        playerId,
        outcomeId: outcome,
        encounterId,
        expectedEncounterRevision: 2n,
        destinationRef,
        correlationId: randomUUID(),
      };
    };
    const concurrentInput = await eligibleNewOutcome(5);
    const concurrentIssues = await Promise.all(
      Array.from({ length: 6 }, () => issuer.issue(concurrentInput)),
    );
    expect(concurrentIssues.every((result) => result.ok)).toBe(true);
    const issuedResults = concurrentIssues.flatMap((result) => (result.ok ? [result.value] : []));
    expect(new Set(issuedResults.map((value) => value.menuId)).size).toBe(1);
    expect(new Set(issuedResults.map((value) => value.outboxMessageId)).size).toBe(1);
    expect(issuedResults.filter((value) => !value.replayed)).toHaveLength(1);
    expect(issuedResults.filter((value) => value.replayed)).toHaveLength(5);
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM solo_incidental_menu_snapshots WHERE outcome_id=$1",
          [concurrentInput.outcomeId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM outbox_messages WHERE idempotency_key=$1",
          ["exploration-issued-menu:" + concurrentInput.outcomeId],
        )
      ).rows[0]?.count,
    ).toBe(1);

    const failureInput = await eligibleNewOutcome(6);
    // Temporary test-only trigger injects failure *after* menu INSERT, when
    // the same SQL transaction tries to enqueue the transport message.
    await pool.query(
      `CREATE FUNCTION test_exploration_menu_outbox_failure()
       RETURNS trigger LANGUAGE plpgsql AS $menu_failure$
       BEGIN
         IF NEW.idempotency_key = 'exploration-issued-menu:${failureInput.outcomeId}' THEN
           RAISE EXCEPTION 'synthetic menu Outbox failure';
         END IF;
         RETURN NEW;
       END $menu_failure$`,
    );
    await pool.query(
      `CREATE TRIGGER test_exploration_menu_outbox_failure_trigger
       BEFORE INSERT ON outbox_messages FOR EACH ROW
       EXECUTE FUNCTION test_exploration_menu_outbox_failure()`,
    );
    try {
      await expect(issuer.issue(failureInput)).rejects.toThrow("synthetic menu Outbox failure");
      expect(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM solo_incidental_menu_snapshots WHERE outcome_id=$1",
            [failureInput.outcomeId],
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM outbox_messages WHERE idempotency_key=$1",
            ["exploration-issued-menu:" + failureInput.outcomeId],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS test_exploration_menu_outbox_failure_trigger ON outbox_messages",
      );
      await pool.query("DROP FUNCTION IF EXISTS test_exploration_menu_outbox_failure()");
    }
    const afterRollback = await issuer.issue(failureInput);
    expect(afterRollback).toMatchObject({ ok: true, value: { replayed: false } });
    // A failed transaction leaves no orphan that could suppress a retry.

    // Prove that ACTIONABLE rights cannot be conferred by changing only the
    // snapshot panel: the exact SENT Outbox must opt in with the same menu ID.
    const wrongActionOutcome = randomUUID();
    const wrongActionMenu = randomUUID();
    const wrongActionOutbox = randomUUID();
    await pool.query(
      `INSERT INTO solo_expedition_search_outcomes(
        id,player_id,expedition_id,expedition_revision,kind,encounter_id
      ) VALUES($1,$2,$3,3,'DIRECT',$4)`,
      [wrongActionOutcome, playerId, expedition.expeditionId, encounterId],
    );
    await pool.query(
      `INSERT INTO solo_incidental_menu_snapshots(
        id,player_id,outcome_id,encounter_id,encounter_revision,panel,ball_item_ids
      ) VALUES($1,$2,$3,$4,2,$5::jsonb,$6::jsonb)`,
      [
        wrongActionMenu,
        playerId,
        wrongActionOutcome,
        encounterId,
        JSON.stringify({ mode: "ACTIONABLE", actions: ["CAPTURE", "BATTLE"] }),
        JSON.stringify({ "2": availableBallId }),
      ],
    );
    await pool.query(
      `INSERT INTO outbox_messages(
        id,channel,message_type,destination_ref,status,sent_at,payload,idempotency_key,correlation_id
      ) VALUES($1,'whatsapp','TEXT',$2,'SENT',now(),$3::jsonb,$4,$5)`,
      [
        wrongActionOutbox,
        destinationRef,
        JSON.stringify({
          text: "Mismatch: do not allow mechanical actions",
          expeditionSearch: {
            playerId,
            outcomeId: wrongActionOutcome,
            encounterId,
          },
          expeditionMenu: { menuId: wrongActionMenu, mode: "READ_ONLY" },
        }),
        "nonactionable-mismatch-pg18-" + wrongActionOutbox,
        randomUUID(),
      ],
    );
    await pool.query(
      `INSERT INTO solo_incidental_menu_deliveries(
        id,menu_id,player_id,provider,chat_ref,external_message_id
      ) VALUES($1,$2,$3,'baileys',$4,$5)`,
      [
        randomUUID(),
        wrongActionMenu,
        playerId,
        destinationRef,
        wrongActionOutbox.replaceAll("-", "").toUpperCase(),
      ],
    );
    expect(
      await menuProof.resolve({
        ...quoted,
        replyToExternalMessageId: wrongActionOutbox.replaceAll("-", "").toUpperCase(),
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });

    const actionOutcome = randomUUID();
    const actionMenu = randomUUID();
    const actionOutbox = randomUUID();
    await pool.query(
      `INSERT INTO solo_expedition_search_outcomes(
        id,player_id,expedition_id,expedition_revision,kind,encounter_id
      ) VALUES($1,$2,$3,4,'DIRECT',$4)`,
      [actionOutcome, playerId, expedition.expeditionId, encounterId],
    );
    await pool.query(
      `INSERT INTO solo_incidental_menu_snapshots(
        id,player_id,outcome_id,encounter_id,encounter_revision,panel,ball_item_ids,created_at
      ) VALUES($1,$2,$3,$4,2,$5::jsonb,$6::jsonb,now()+interval '5 seconds')`,
      [
        actionMenu,
        playerId,
        actionOutcome,
        encounterId,
        JSON.stringify({
          mode: "ACTIONABLE",
          actions: ["CAPTURE", "BATTLE"],
          text: "Synthetic mechanical consent: NOT sent to WhatsApp",
        }),
        JSON.stringify({ "2": availableBallId }),
      ],
    );
    await pool.query(
      `INSERT INTO outbox_messages(
        id,channel,message_type,destination_ref,status,sent_at,payload,idempotency_key,correlation_id
      ) VALUES($1,'whatsapp','TEXT',$2,'SENT',now(),$3::jsonb,$4,$5)`,
      [
        actionOutbox,
        destinationRef,
        JSON.stringify({
          text: "Synthetic mechanical consent: NOT sent to WhatsApp",
          expeditionSearch: { playerId, outcomeId: actionOutcome, encounterId },
          expeditionMenu: {
            menuId: actionMenu,
            mode: "ACTIONABLE",
            actions: ["CAPTURE", "BATTLE"],
            ballItemIds: { "2": availableBallId },
          },
        }),
        "actionable-consent-pg18-" + actionOutbox,
        randomUUID(),
      ],
    );
    await pool.query(
      `INSERT INTO solo_incidental_menu_deliveries(
        id,menu_id,player_id,provider,chat_ref,external_message_id
      ) VALUES($1,$2,$3,'baileys',$4,$5)`,
      [
        randomUUID(),
        actionMenu,
        playerId,
        destinationRef,
        actionOutbox.replaceAll("-", "").toUpperCase(),
      ],
    );
    expect(
      await menuProof.resolve({
        ...quoted,
        replyToExternalMessageId: actionOutbox.replaceAll("-", "").toUpperCase(),
      }),
    ).toEqual(
      ok({
        menuId: actionMenu,
        playerId,
        outcomeId: actionOutcome,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": availableBallId },
        actionable: true,
        captureEnabled: true,
        battleEnabled: true,
      }),
    );
    const otherPlayer = await trainer();
    expect(await quoteResolver.resolve({ ...quoted, playerId: otherPlayer })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(
      await quoteResolver.resolve({
        ...quoted,
        replyToExternalMessageId: randomUUID().replaceAll("-", "").toUpperCase(),
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(
      await quoteResolver.resolve({
        ...quoted,
        senderRef: "5588888888888@s.whatsapp.net",
        chatRef: "5588888888888@s.whatsapp.net",
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(
      await quoteResolver.resolve({ ...quoted, chatRef: "120363123456789@g.us" }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    const seen = await pool.query<{ seen_count: number; caught_count: number }>(
      "SELECT seen_count::int AS seen_count,caught_count::int AS caught_count FROM player_pokedex_species WHERE player_id=$1 AND species_id=$2",
      [playerId, speciesId],
    );
    expect(seen.rows).toMatchObject([{ seen_count: 1, caught_count: 0 }]);
    const battles = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM battles WHERE encounter_id=$1",
      [encounterId],
    );
    expect(battles.rows[0]?.n).toBe(0);
  });
  it("routes an authorized Ball to real CaptureService + PostgresCaptureRepository in disposable PG18", async () => {
    // Unlike the unit test, this case commits real capture attempts, inventory
    // ledger and encounter transitions in PostgreSQL. Auth/menu ports remain
    // synthetic because the production WhatsApp runtime is never enabled.
    const playerId = await trainer();
    const encounterId = createEncounterId();
    const captureRulesetId = randomUUID();
    const captureConfig = {
      schemaVersion: 1,
      battle: {
        statModel: "SIX_STATS",
        physicalSpecialByMove: true,
        ivEnabled: true,
        evEnabled: false,
        natureEnabled: true,
        maxMoves: 4,
        ppEnabled: true,
        criticalMultiplierBasisPoints: 15000,
        accuracyEvasionEnabled: true,
      },
      capture: {
        model: "POKEMON_INSPIRED_V1",
        maxProbabilityBasisPoints: 9500,
        allowedEncounterStates: ["ENGAGED", "IN_BATTLE"],
      },
      defeat: { automaticMoneyLoss: false },
      narrative: { authority: "N0_FLAVOR_ONLY" },
    };
    await pool.query(
      `INSERT INTO rulesets(id,key,version,engine_contract_version,config,status)
       VALUES($1,$2,1,1,$3::jsonb,'DRAFT')`,
      [captureRulesetId, "pg18-real-capture-" + captureRulesetId, JSON.stringify(captureConfig)],
    );
    await pool.query(
      "UPDATE rulesets SET status='VALIDATED',validated_at=now(),validation_report=$2::jsonb,config_fingerprint=$3 WHERE id=$1",
      [captureRulesetId, JSON.stringify({ valid: true, issues: [] }), "c".repeat(64)],
    );
    await pool.query("UPDATE rulesets SET status='PUBLISHED',published_at=now() WHERE id=$1", [
      captureRulesetId,
    ]);
    await pool.query(
      `INSERT INTO encounters(
         id,player_id,area_id,status,content_release_id,ruleset_id,
         rng_seed_ciphertext,rng_seed_iv,rng_seed_auth_tag,rng_seed_key_version,
         rng_counter,revision,creation_idempotency_key
       ) VALUES($1,$2,$3,'ENGAGED',$4,$5,$6,$7,$8,1,0,2,$9)`,
      [
        encounterId,
        playerId,
        activeAreaId,
        publishedReleaseId,
        captureRulesetId,
        Buffer.alloc(32, 0x55),
        Buffer.alloc(12, 0x56),
        Buffer.alloc(16, 0x57),
        "pg18-real-capture-encounter-" + encounterId,
      ],
    );
    await pool.query(
      "INSERT INTO encounter_snapshots(encounter_id,schema_version,pokemon_snapshot) VALUES($1,1,$2::jsonb)",
      [encounterId, JSON.stringify(publishedCaptureSnapshot)],
    );
    await pool.query(
      `INSERT INTO encounter_wild_snapshots(
         encounter_id,wild_no,status,schema_version,pokemon_snapshot,created_at,updated_at
       ) VALUES($1,1,'ACTIVE',1,$2::jsonb,now(),now())`,
      [encounterId, JSON.stringify(publishedCaptureSnapshot)],
    );
    await pool.query("INSERT INTO inventory_balances(player_id,item_id,quantity) VALUES($1,$2,1)", [
      playerId,
      publishedBallItemId,
    ]);
    const capture = new CaptureService(
      new PostgresCaptureRepository(pool),
      new AesEncounterSeedProvider(Buffer.alloc(32, 0xa5), 1, () => Buffer.alloc(32)),
    );
    const outcomeId = randomUUID();
    const destinationRef = "5579999999999@s.whatsapp.net";
    const activeEncounters = new EncounterOperationalReadService(
      new PostgresEncounterRepository(pool),
    );
    const issuedExpedition = await prepare(playerId, "pg18-real-all-authorities-prepare");
    const activatedExpedition = await store.advance({
      playerId,
      expeditionId: issuedExpedition.expeditionId,
      expectedRevision: issuedExpedition.revision,
      minutes: 30,
      idempotencyKey: "pg18-real-all-authorities-active",
    });
    expect(activatedExpedition.ok).toBe(true);
    await pool.query(
      `INSERT INTO player_identities(id,player_id,provider,external_id,status)
       VALUES($1,$2,'baileys',$3,'ACTIVE')`,
      [randomUUID(), playerId, destinationRef],
    );
    await pool.query(
      `INSERT INTO player_onboarding_context(player_id,content_release_id,ruleset_id)
       VALUES($1,$2,$3)`,
      [playerId, publishedReleaseId, captureRulesetId],
    );
    await pool.query(
      `INSERT INTO solo_expedition_search_outcomes(
         id,player_id,expedition_id,expedition_revision,kind,encounter_id
       ) VALUES($1,$2,$3,2,'DIRECT',$4)`,
      [outcomeId, playerId, issuedExpedition.expeditionId, encounterId],
    );

    // This result is actually delivered according to the test SQL transport
    // state. The ACTIONABLE menu below is created by production-shaped issuer
    // transaction, NOT manually forged snapshot/Outbox/delivery INSERTs.
    const sourceMessageId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_messages(
         id,channel,message_type,destination_ref,status,sent_at,payload,
         idempotency_key,correlation_id
       ) VALUES($1,'whatsapp','TEXT',$2,'SENT',now(),$3::jsonb,$4,$5)`,
      [
        sourceMessageId,
        destinationRef,
        JSON.stringify({
          text: "Verified synthetic search result",
          expeditionSearch: { playerId, outcomeId, encounterId },
        }),
        "pg18-actionable-source:" + sourceMessageId,
        randomUUID(),
      ],
    );
    const actionableIssuer = new PostgresExpeditionOfflineActionableMenuIssuer(pool);
    const issueInput = {
      playerId,
      outcomeId,
      encounterId,
      expectedEncounterRevision: 2n,
      destinationRef,
      correlationId: randomUUID(),
    };
    const issuedActionable = await actionableIssuer.issue(issueInput);
    expect(issuedActionable).toMatchObject({
      ok: true,
      value: { replayed: false, ballItemIds: { "2": publishedBallItemId } },
    });
    if (!issuedActionable.ok) throw new Error("Verified offline issuer refused canonical Ball");
    expect(issuedActionable.value.text).toContain("2. ◉ Poké Ball ● \`×1\`");
    expect(issuedActionable.value.text).toContain("◇ *𝗖𝗔𝗣𝗧𝗨𝗥𝗔𝗥*");
    expect(issuedActionable.value.text).toContain("Nv.");
    expect(issuedActionable.value.text).not.toContain("1. ⚔️ Batalhar");
    expect(issuedActionable.value.text).not.toContain("0. ↩️ Ignorar");
    expect(issuedActionable.value.text).not.toContain("[Ler mais]");
    expect(issuedActionable.value.text).not.toContain("somente prévia");
    const emittedMenuId = issuedActionable.value.menuId;
    const emittedOutboxId = issuedActionable.value.outboxMessageId;
    const emittedQuote = emittedOutboxId.replaceAll("-", "").toUpperCase();
    expect(await actionableIssuer.issue(issueInput)).toEqual(
      ok({ ...issuedActionable.value, replayed: true }),
    );
    // Same outcome cannot be silently down-graded/up-graded after issuing.
    // Neither mode may overwrite an existing immutable Outbox binding.
    expect(await new PostgresExpeditionReadOnlyMenuIssuer(pool).issue(issueInput)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    const persistedActionable = await pool.query<{
      mode: string;
      status: string;
      actions: string[];
    }>(
      `SELECT menu.panel->>'mode' AS mode, outbox.status,
              jsonb_array_elements_text(menu.panel->'actions') AS action
       FROM solo_incidental_menu_snapshots menu
       JOIN solo_incidental_menu_deliveries delivery ON delivery.menu_id=menu.id
       JOIN outbox_messages outbox
         ON upper(replace(outbox.id::text,'-',''))=upper(delivery.external_message_id)
       WHERE menu.id=$1`,
      [emittedMenuId],
    );
    expect(persistedActionable.rows).toMatchObject([{ mode: "ACTIONABLE", status: "PENDING" }]);
    const storedPanel = await pool.query<{
      snapshot_text: string;
      outbox_text: string;
      ball_item_ids: Record<string, string>;
    }>(
      `SELECT menu.panel->>'text' AS snapshot_text,
              outbox.payload->>'text' AS outbox_text,
              menu.ball_item_ids
       FROM solo_incidental_menu_snapshots menu
       JOIN solo_incidental_menu_deliveries delivery ON delivery.menu_id=menu.id
       JOIN outbox_messages outbox
         ON upper(replace(outbox.id::text,'-',''))=upper(delivery.external_message_id)
       WHERE menu.id=$1`,
      [emittedMenuId],
    );
    expect(storedPanel.rows).toEqual([
      {
        snapshot_text: issuedActionable.value.text,
        outbox_text: issuedActionable.value.text,
        ball_item_ids: { "2": publishedBallItemId },
      },
    ]);
    const players = new PlayerRegistrationService(new PostgresPlayerOnboardingRepository(pool));
    const quotedEncounter = new PostgresExpeditionQuotedEncounterProof(pool);
    const issuedMenuProof = new PostgresExpeditionIssuedMenuReplyProof(pool);
    const gateway = new ExpeditionCanonicalChoiceStagingResolver(
      players,
      quotedEncounter,
      activeEncounters,
      issuedMenuProof,
      capture,
      {
        async startCanonical(): Promise<never> {
          throw new Error("Capture must not start PvE");
        },
      } as unknown as ConstructorParameters<typeof ExpeditionCanonicalChoiceStagingResolver>[5],
    );
    const correlationId = createCorrelationId();
    const receivedExternalId = randomUUID();
    const context: MessageHandlerContext = {
      inboxMessageId: randomUUID(),
      causationId: randomUUID(),
      correlationId,
      idempotencyKey: "inbox:baileys:" + receivedExternalId,
      message: {
        provider: "baileys",
        externalMessageId: receivedExternalId,
        senderRef: destinationRef,
        chatRef: destinationRef,
        occurredAt: "2026-11-02T01:50:00.000Z",
        text: "2",
        replyToExternalMessageId: randomUUID().replaceAll("-", "").toUpperCase(),
        mediaRefs: [],
      },
    };
    const realContext: MessageHandlerContext = {
      ...context,
      message: { ...context.message, replyToExternalMessageId: emittedQuote },
    };
    // Reject forged, not-delivered and wrong-owner quoted requests BEFORE RNG.
    expect(await gateway.resolve(realContext)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(
      (
        await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM capture_attempts WHERE encounter_id=$1",
          [encounterId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    const otherRef = "5579999999998@s.whatsapp.net";
    expect(
      await gateway.resolve({
        ...realContext,
        message: { ...realContext.message, senderRef: otherRef, chatRef: otherRef },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await pool.query("UPDATE outbox_messages SET status='SENT',sent_at=now() WHERE id=$1", [
      emittedOutboxId,
    ]);
    const proofInput = {
      provider: "baileys",
      playerId,
      senderRef: destinationRef,
      chatRef: destinationRef,
      replyToExternalMessageId: emittedQuote,
    };
    expect(await quotedEncounter.resolve(proofInput)).toEqual(
      ok({ playerId, outcomeId, encounterId, encounterRevision: 2n }),
    );
    expect(await issuedMenuProof.resolve(proofInput)).toEqual(
      ok({
        menuId: emittedMenuId,
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": publishedBallItemId },
        actionable: true,
        captureEnabled: true,
        battleEnabled: false,
      }),
    );
    // A real PostgreSQL Inbox claim establishes the exact correlation/fingerprint
    // that must later be used to recover a previously committed capture.
    const inboxRepository = new PostgresMessagingRepository(pool);
    const firstClaim = await inboxRepository.claimIncoming(
      IncomingMessageSchema.parse(realContext.message),
      30_000,
    );
    expect(firstClaim).toMatchObject({ ok: true, value: { status: "CLAIMED" } });
    if (!firstClaim.ok) throw new Error("Unable to claim incoming test message");
    const claimedContext: MessageHandlerContext = {
      ...realContext,
      inboxMessageId: firstClaim.value.inboxMessageId,
      correlationId: firstClaim.value.correlationId,
      causationId: firstClaim.value.inboxMessageId,
    };
    const first = await gateway.resolve(claimedContext);
    expect(first).toMatchObject({
      ok: true,
      value: { resultRefType: "ENCOUNTER" },
    });
    if (!first.ok) throw new Error("Real capture repository declined the published test fixture");
    const beforeReplay = await pool.query<{
      attempts: number;
      ledger: number;
      internal_outbox: number;
      balance: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM capture_attempts WHERE encounter_id=$1) AS attempts,
         (SELECT count(*)::int FROM inventory_ledger
          WHERE player_id=$2 AND item_id=$3 AND source_type='CAPTURE_ATTEMPT') AS ledger,
         (SELECT count(*)::int FROM outbox_messages
          WHERE channel='INTERNAL' AND idempotency_key LIKE 'capture.result:%'
            AND payload->>'encounterId'=$1::text) AS internal_outbox,
         (SELECT quantity::text FROM inventory_balances
          WHERE player_id=$2 AND item_id=$3) AS balance`,
      [encounterId, playerId, publishedBallItemId],
    );
    expect(beforeReplay.rows).toMatchObject([
      { attempts: 1, ledger: 1, internal_outbox: 1, balance: "0" },
    ]);

    // Simulate a transient Inbox/Outbox completion failure *after* the Ball
    // was consumed in PostgreSQL. On redelivery, the live Encounter/quote is
    // already stale; exact Inbox + recorded attempt must reconstruct the
    // original response and commit its WhatsApp Outbox without another throw.
    await inboxRepository.failIncoming(firstClaim.value.inboxMessageId, "INJECTED_AFTER_CAPTURE");
    const recoveryGateway = new ExpeditionCanonicalChoiceStagingResolver(
      players,
      quotedEncounter,
      activeEncounters,
      issuedMenuProof,
      capture,
      {
        async startCanonical(): Promise<never> {
          throw new Error("Recovery must not start PvE");
        },
      } as unknown as ConstructorParameters<typeof ExpeditionCanonicalChoiceStagingResolver>[5],
      new PostgresExpeditionCaptureConfirmationRecovery(pool),
    );
    const recoveryMessage = new MessagingService(
      inboxRepository,
      new MessageRouter([], undefined, recoveryGateway),
    );
    // Even after a committed capture, a modified text with the same external
    // message ID is NOT a replay. The persisted normalized fingerprint wins.
    expect(await recoveryMessage.receive({ ...realContext.message, text: "3" })).toMatchObject({
      ok: false,
      error: { code: "FINGERPRINT_MISMATCH" },
    });
    const deliveredAgain = await recoveryMessage.receive(realContext.message);
    if (!deliveredAgain.ok) {
      throw new Error("Capture reply retry error: " + JSON.stringify(deliveredAgain.error));
    }
    expect(deliveredAgain).toMatchObject({
      ok: true,
      value: { status: "PROCESSED", resultRefType: "ENCOUNTER", resultRefId: encounterId },
    });
    const secondDelivery = await recoveryMessage.receive(realContext.message);
    expect(secondDelivery).toMatchObject({
      ok: true,
      value: { status: "REPLAYED", resultRefType: "ENCOUNTER", resultRefId: encounterId },
    });
    const recoveredOutgoing = await pool.query<{
      status: string;
      text: string;
    }>(
      `SELECT status,payload->>'text' AS text FROM outbox_messages
       WHERE idempotency_key=$1 AND channel='whatsapp'`,
      [claimedContext.idempotencyKey + ":expedition-canonical-capture"],
    );
    expect(recoveredOutgoing.rows).toHaveLength(1);
    expect(recoveredOutgoing.rows[0]?.status).toBe("PENDING");
    expect(recoveredOutgoing.rows[0]?.text).toBe(first.value?.outgoing[0]?.payload.text);
    const sentConfirmations: string[] = [];
    const confirmationWorker = new OutboxWorker(
      inboxRepository,
      [
        {
          channel: "whatsapp",
          send: async (outgoing) => {
            if (
              outgoing.idempotencyKey ===
              claimedContext.idempotencyKey + ":expedition-canonical-capture"
            ) {
              sentConfirmations.push(outgoing.id);
            }
            return { providerExternalMessageId: outgoing.id.replaceAll("-", "").toUpperCase() };
          },
        },
      ],
      {
        batchSize: 10000,
        staleAfterMs: 30000,
        maxAttempts: 8,
        baseBackoffMs: 1000,
        maxBackoffMs: 60000,
      },
    );
    await confirmationWorker.runOnce();
    await confirmationWorker.runOnce();
    expect(sentConfirmations).toHaveLength(1);
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM outbox_messages WHERE idempotency_key=$1",
          [claimedContext.idempotencyKey + ":expedition-canonical-capture"],
        )
      ).rows[0]?.status,
    ).toBe("SENT");
    const recordedCapture = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM capture_attempts WHERE encounter_id=$1",
      [encounterId],
    );
    expect(recordedCapture.rows[0]?.count).toBe(1);
    const replay = await capture.attempt({
      playerId,
      encounterId,
      expectedEncounterRevision: 2n,
      expectedBattleVersion: null,
      ballItemId: publishedBallItemId,
      idempotencyKey: claimedContext.idempotencyKey,
      correlationId: createCorrelationId(),
      causationId: context.causationId,
    });
    expect(replay).toMatchObject({ ok: true, value: { replayed: true } });
    const afterReplay = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM capture_attempts WHERE encounter_id=$1) AS attempts,
         (SELECT count(*)::int FROM inventory_ledger
          WHERE player_id=$2 AND item_id=$3 AND source_type='CAPTURE_ATTEMPT') AS ledger,
         (SELECT count(*)::int FROM outbox_messages
          WHERE channel='INTERNAL' AND payload->>'encounterId'=$1::text) AS internal_outbox,
         (SELECT quantity::text FROM inventory_balances
          WHERE player_id=$2 AND item_id=$3) AS balance`,
      [encounterId, playerId, publishedBallItemId],
    );
    expect(afterReplay.rows).toEqual(beforeReplay.rows);
    const competing = await capture.attempt({
      playerId,
      encounterId,
      expectedEncounterRevision: 2n,
      expectedBattleVersion: null,
      ballItemId: publishedBallItemId,
      idempotencyKey: "pg18-competing-capture:" + encounterId,
      correlationId: createCorrelationId(),
      causationId: null,
    });
    expect(competing.ok).toBe(false);
    // Even a distinct submitted action cannot consume a second Ball after
    // the first canonical transaction changed the encounter revision/status.
    const final = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",
      [playerId, publishedBallItemId],
    );
    expect(final.rows[0]?.quantity).toBe("0");

    // The first test above covered sequential retry. Now race two DIFFERENT
    // inbox keys against the same ACTIVE encounter with ONE actual Ball.
    // PostgreSQL must serialize the encounter lock: exactly one attempt and
    // one debit, regardless of which submission wins.
    const racingPlayerId = await trainer();
    const racingEncounterId = createEncounterId();
    await pool.query(
      `INSERT INTO encounters(
         id,player_id,area_id,status,content_release_id,ruleset_id,
         rng_seed_ciphertext,rng_seed_iv,rng_seed_auth_tag,rng_seed_key_version,
         rng_counter,revision,creation_idempotency_key
       ) VALUES($1,$2,$3,'ENGAGED',$4,$5,$6,$7,$8,1,0,2,$9)`,
      [
        racingEncounterId,
        racingPlayerId,
        activeAreaId,
        publishedReleaseId,
        captureRulesetId,
        Buffer.alloc(32, 0x65),
        Buffer.alloc(12, 0x66),
        Buffer.alloc(16, 0x67),
        "pg18-racing-capture-encounter-" + racingEncounterId,
      ],
    );
    await pool.query(
      "INSERT INTO encounter_snapshots(encounter_id,schema_version,pokemon_snapshot) VALUES($1,1,$2::jsonb)",
      [racingEncounterId, JSON.stringify(publishedCaptureSnapshot)],
    );
    await pool.query(
      `INSERT INTO encounter_wild_snapshots(
         encounter_id,wild_no,status,schema_version,pokemon_snapshot,created_at,updated_at
       ) VALUES($1,1,'ACTIVE',1,$2::jsonb,now(),now())`,
      [racingEncounterId, JSON.stringify(publishedCaptureSnapshot)],
    );
    await pool.query("INSERT INTO inventory_balances(player_id,item_id,quantity) VALUES($1,$2,1)", [
      racingPlayerId,
      publishedBallItemId,
    ]);
    const raceBase = {
      playerId: racingPlayerId,
      encounterId: racingEncounterId,
      expectedEncounterRevision: 2n,
      expectedBattleVersion: null,
      ballItemId: publishedBallItemId,
      causationId: null,
    } as const;
    const choiceA = {
      ...raceBase,
      idempotencyKey: "pg18-racing-throw-A:" + racingEncounterId,
      correlationId: createCorrelationId(),
    };
    const choiceB = {
      ...raceBase,
      idempotencyKey: "pg18-racing-throw-B:" + racingEncounterId,
      correlationId: createCorrelationId(),
    };
    const [raceA, raceB] = await Promise.all([capture.attempt(choiceA), capture.attempt(choiceB)]);
    const winningKeys = [...(raceA.ok ? [choiceA] : []), ...(raceB.ok ? [choiceB] : [])];
    expect(winningKeys).toHaveLength(1);
    expect([raceA.ok, raceB.ok].filter(Boolean)).toHaveLength(1);
    const racedCounts = await pool.query<{
      attempts: number;
      ledger: number;
      internal_outbox: number;
      balance: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM capture_attempts WHERE encounter_id=$1) AS attempts,
         (SELECT count(*)::int FROM inventory_ledger
          WHERE player_id=$2 AND item_id=$3 AND source_type='CAPTURE_ATTEMPT') AS ledger,
         (SELECT count(*)::int FROM outbox_messages
          WHERE channel='INTERNAL' AND payload->>'encounterId'=$1::text) AS internal_outbox,
         (SELECT quantity::text FROM inventory_balances
          WHERE player_id=$2 AND item_id=$3) AS balance`,
      [racingEncounterId, racingPlayerId, publishedBallItemId],
    );
    expect(racedCounts.rows).toMatchObject([
      { attempts: 1, ledger: 1, internal_outbox: 1, balance: "0" },
    ]);
    const winner = winningKeys[0];
    if (winner === undefined) throw new Error("Racing captures produced no winning transaction");
    expect(
      await capture.attempt({ ...winner, correlationId: createCorrelationId() }),
    ).toMatchObject({ ok: true, value: { replayed: true } });
    // A replay cannot update the ledger or Outbox either.
    const afterRacingReplay = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM capture_attempts WHERE encounter_id=$1) AS attempts,
         (SELECT count(*)::int FROM inventory_ledger
          WHERE player_id=$2 AND item_id=$3 AND source_type='CAPTURE_ATTEMPT') AS ledger,
         (SELECT count(*)::int FROM outbox_messages
          WHERE channel='INTERNAL' AND payload->>'encounterId'=$1::text) AS internal_outbox,
         (SELECT quantity::text FROM inventory_balances
          WHERE player_id=$2 AND item_id=$3) AS balance`,
      [racingEncounterId, racingPlayerId, publishedBallItemId],
    );
    expect(afterRacingReplay.rows).toEqual(racedCounts.rows);
  });
});
