import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { FakeWhatsAppAdapter } from "../../src/adapters/whatsapp/fake-whatsapp-adapter.js";
import { CatalogService } from "../../src/modules/catalog/service.js";
import type { IncomingMessage, MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessagingService } from "../../src/modules/messaging/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { PlayerProvisioningService } from "../../src/modules/registration/provisioning-service.js";
import { PlayerProvisioningWorker } from "../../src/modules/registration/provisioning-worker.js";
import { appError, err } from "../../src/shared-kernel/result.js";
import { PostgresAdminRegistrySeed } from "../../src/platform/admin/postgres-admin-registry-seed.js";
import { reconcileCanonicalAdminRegistry } from "../../src/platform/admin/postgres-admin-registry-seed.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { SystemClock } from "../../src/platform/clock/index.js";
import { withTransaction } from "../../src/platform/db/transaction.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { PostgresPlayerAccessRepository } from "../../src/platform/registration/postgres-player-access-repository.js";
import { PostgresProvisioningCandidateSource } from "../../src/platform/registration/postgres-provisioning-candidate-source.js";
import { PostgresReceptionActivationAnnouncement } from "../../src/platform/registration/postgres-reception-activation-announcement.js";
import { PostgresRegistrationRepository } from "../../src/platform/registration/postgres-registration-repository.js";
import { PostgresRegistrationSetupLoader } from "../../src/platform/registration/postgres-registration-setup-loader.js";
import { CryptoRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import { WorldService } from "../../src/modules/world/service.js";
import {
  createOperationalMessagingComposition,
  createOperationalOutboxWorker,
} from "../../src/runtime/compose-whatsapp-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required for reception registration E2E");

const RECEPTION_CHAT = "120363000000009001@g.us";
const WORLD_CHAT = "120363000000009002@g.us";
const PLAYER_JID = "5511999999001@s.whatsapp.net";
const ADMIN_JID = "5511999999002@s.whatsapp.net";

function unwrap<T>(label: string, result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function prepareZhouliaRelease(pool: Pool): Promise<{
  readonly regionId: string;
  readonly starterNames: readonly [string, string];
}> {
  const catalog = new CatalogService(new PostgresCatalogRepository(pool));
  const active = await pool.query<{ id: string; release_no: string }>(
    `SELECT release.id, release.release_no::text
     FROM content_release_pointers pointer
     JOIN content_releases release ON release.id = pointer.content_release_id
     WHERE pointer.pointer_key = 'ACTIVE' AND release.status = 'PUBLISHED'`,
  );
  const parent = active.rows[0];
  if (parent === undefined) throw new Error("Reception E2E requires an active published release");

  const maxRelease = await pool.query<{ release_no: string }>(
    "SELECT COALESCE(MAX(release_no), 0)::text AS release_no FROM content_releases",
  );
  const releaseNo = BigInt(maxRelease.rows[0]?.release_no ?? parent.release_no) + 1n;
  const releaseId = randomUUID();
  unwrap(
    "clone reception proof release",
    await catalog.clonePublishedRelease({
      parentReleaseId: parent.id,
      newReleaseId: releaseId,
      releaseNo,
      name: "Reception Registration E2E Zhoulia",
    }),
  );

  const regionId = await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO regions(id, slug)
       VALUES ($1, 'zhoulia')
       ON CONFLICT (slug) DO NOTHING`,
      [randomUUID()],
    );
    const region = await client.query<{ id: string }>("SELECT id FROM regions WHERE slug = 'zhoulia'");
    const resolvedRegionId = region.rows[0]?.id;
    if (resolvedRegionId === undefined) throw new Error("Could not resolve Zhoulia region identity");

    await client.query(
      `INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active)
       VALUES ($1, $2, $3, 'Zhoulia', TRUE)`,
      [randomUUID(), releaseId, resolvedRegionId],
    );

    const existingStarters = await client.query<{ form_id: string; starter_level: number }>(
      `SELECT form_id, starter_level
       FROM starter_options
       WHERE content_release_id = $1 AND active = TRUE
       ORDER BY sort_order, form_id
       LIMIT 2`,
      [releaseId],
    );
    if (existingStarters.rows.length < 2) {
      throw new Error("Reception E2E requires at least two canonical starter builds");
    }
    for (const [index, starter] of existingStarters.rows.entries()) {
      await client.query(
        `INSERT INTO starter_options(
           id, content_release_id, region_id, form_id, starter_level, sort_order, active
         ) VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
        [randomUUID(), releaseId, resolvedRegionId, starter.form_id, starter.starter_level, index + 1],
      );
    }

    const gateId = await ensureArea(client, resolvedRegionId, "zhoulia-gate");
    const roadId = await ensureArea(client, resolvedRegionId, "zhoulia-road");
    await client.query(
      `INSERT INTO area_revisions(id, content_release_id, area_id, display_name, active, data)
       VALUES
         ($1, $2, $3, 'Portão de Zhoulia', TRUE, $4::jsonb),
         ($5, $2, $6, 'Estrada de Zhoulia', TRUE, $7::jsonb)`,
      [
        randomUUID(),
        releaseId,
        gateId,
        JSON.stringify({
          schemaVersion: 1,
          kind: "TOWN",
          safePoint: true,
          startingArea: true,
          relocationPriority: 0,
        }),
        randomUUID(),
        roadId,
        JSON.stringify({
          schemaVersion: 1,
          kind: "ROUTE",
          safePoint: false,
          startingArea: false,
          relocationPriority: 100,
        }),
      ],
    );
    await ensureConnection(client, releaseId, gateId, roadId, "outbound");
    await ensureConnection(client, releaseId, roadId, gateId, "return");
    return resolvedRegionId;
  });

  unwrap("validate reception proof release", await catalog.validateRelease(releaseId));
  unwrap("publish reception proof release", await catalog.publishRelease(releaseId));

  const setup = unwrap("load Zhoulia registration setup", await new PostgresRegistrationSetupLoader(pool).load());
  assert.equal(setup.regionId, regionId);
  assert.ok(setup.starterOptions.length >= 2);
  const first = setup.starterOptions[0]?.displayName;
  const second = setup.starterOptions[1]?.displayName;
  if (first === undefined || second === undefined) throw new Error("Starter display names are unavailable");
  return { regionId, starterNames: [first, second] };
}

async function ensureArea(client: PoolClient, regionId: string, slug: string): Promise<string> {
  await client.query(
    `INSERT INTO areas(id, region_id, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (region_id, slug) DO NOTHING`,
    [randomUUID(), regionId, slug],
  );
  const result = await client.query<{ id: string }>(
    "SELECT id FROM areas WHERE region_id = $1 AND slug = $2",
    [regionId, slug],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`Could not resolve area ${slug}`);
  return id;
}

async function ensureConnection(
  client: PoolClient,
  releaseId: string,
  fromAreaId: string,
  toAreaId: string,
  connectionKey: string,
): Promise<void> {
  const connectionId = randomUUID();
  await client.query(
    `INSERT INTO area_connections(id, from_area_id, to_area_id, connection_key)
     VALUES ($1, $2, $3, $4)`,
    [connectionId, fromAreaId, toAreaId, connectionKey],
  );
  await client.query(
    `INSERT INTO area_connection_revisions(
       id, content_release_id, connection_id, access_rule, active
     ) VALUES ($1, $2, $3, $4::jsonb, TRUE)`,
    [
      randomUUID(),
      releaseId,
      connectionId,
      JSON.stringify({ schemaVersion: 1, requiredUnlockKeys: [] }),
    ],
  );
}

async function configureReception(pool: Pool): Promise<{ adminPrincipalId: string }> {
  return withTransaction(pool, async (client) => {
    await reconcileCanonicalAdminRegistry(client);
    const role = await client.query<{ id: string }>(
      "SELECT id FROM admin_roles WHERE slug = 'RECEPTION_MOD'",
    );
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) throw new Error("RECEPTION_MOD role was not reconciled");

    const adminPrincipalId = randomUUID();
    await client.query(
      "INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')",
      [adminPrincipalId, `whatsapp:${ADMIN_JID}`],
    );
    await client.query("INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)", [
      adminPrincipalId,
      roleId,
    ]);
    await client.query(
      `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
       VALUES ($1, $2, 'GLOBAL', NULL)`,
      [randomUUID(), adminPrincipalId],
    );

    const receptionGroupId = randomUUID();
    const worldGroupId = randomUUID();
    await client.query(
      `INSERT INTO community_groups(id, provider, chat_ref, role, display_name, status)
       VALUES
         ($1, 'baileys', $2, 'RECEPTION', 'Recepção E2E', 'ACTIVE'),
         ($3, 'baileys', $4, 'GAME', 'Mundo E2E', 'ACTIVE')`,
      [receptionGroupId, RECEPTION_CHAT, worldGroupId, WORLD_CHAT],
    );
    for (const capability of ["onboarding", "admin.review"]) {
      await client.query(
        `INSERT INTO community_group_capabilities(group_id, capability_key, active)
         VALUES ($1, $2, TRUE)`,
        [receptionGroupId, capability],
      );
    }
    for (const capability of ["player.basic", "world"]) {
      await client.query(
        `INSERT INTO community_group_capabilities(group_id, capability_key, active)
         VALUES ($1, $2, TRUE)`,
        [worldGroupId, capability],
      );
    }
    await client.query(
      `INSERT INTO reception_staff_assignments(group_id, admin_principal_id, active)
       VALUES ($1, $2, TRUE)`,
      [receptionGroupId, adminPrincipalId],
    );
    return { adminPrincipalId };
  });
}

let messageSequence = 0;
function incoming(
  senderRef: string,
  chatRef: string,
  text: string,
  replyToExternalMessageId: string | null = null,
): IncomingMessage {
  messageSequence += 1;
  return {
    provider: "baileys",
    externalMessageId: `reception-e2e:${messageSequence}`,
    senderRef,
    chatRef,
    occurredAt: new Date(Date.UTC(2026, 8, 3, 20, 0, messageSequence)).toISOString(),
    text,
    mediaRefs: [],
    replyToExternalMessageId,
  };
}

function messaging(pool: Pool) {
  const composition = createOperationalMessagingComposition(pool);
  const repository = new PostgresMessagingRepository(pool);
  const service = new MessagingService(repository, composition.router, 30_000, {
    player: { policyKey: "reception.e2e.player", maxEvents: 500, windowMs: 60_000 },
    chat: { policyKey: "reception.e2e.chat", maxEvents: 1_000, windowMs: 60_000 },
    sensitiveAction: { policyKey: "reception.e2e.sensitive", maxEvents: 500, windowMs: 60_000 },
  });
  return { composition, repository, service };
}

async function receive(service: MessagingService, message: IncomingMessage): Promise<string> {
  const result = unwrap(`receive ${message.text ?? "<freeform>"}`, await service.receive(message));
  assert.equal(result.status, "PROCESSED");
  return result.inboxMessageId;
}

function fullFicha(starter: string, personality: string, backstory: string): string {
  return [
    "Nome: Liora Vale",
    "Idade: 17",
    "Gênero / pronomes: ela/dela",
    "Aparência: Cabelos negros e casaco de viagem.",
    `Personalidade: ${personality}`,
    `História / resumo: ${backstory}`,
    `Pokémon inicial: ${starter}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const { regionId, starterNames } = await prepareZhouliaRelease(pool);
    const { adminPrincipalId } = await configureReception(pool);
    let runtime = messaging(pool);

    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "oi"));
    const identity = await pool.query<{ player_id: string }>(
      `SELECT player_id FROM player_identities
       WHERE provider = 'baileys' AND external_id = $1 AND status = 'ACTIVE'`,
      [PLAYER_JID],
    );
    const playerId = identity.rows[0]?.player_id;
    if (playerId === undefined) throw new Error("Reception welcome did not create a player identity");

    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$registrar"));
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "1"));
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "Liora Vale"));
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "17"));
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "ela/dela"));
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$salvar"));

    const partial = await pool.query<{ trainer_name: string | null; age: number | null; appearance: string | null }>(
      "SELECT trainer_name, age, appearance FROM registration_drafts WHERE player_id = $1",
      [playerId],
    );
    assert.deepEqual(partial.rows[0], { trainer_name: "Liora Vale", age: 17, appearance: null });

    runtime = messaging(pool);
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$continuar"));
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$modo completo"));
    await receive(
      runtime.service,
      incoming(
        PLAYER_JID,
        RECEPTION_CHAT,
        fullFicha(starterNames[0], "Curiosa e competitiva.", "Saiu de casa para pesquisar Pokémon raros."),
      ),
    );
    await receive(
      runtime.service,
      incoming(
        PLAYER_JID,
        RECEPTION_CHAT,
        fullFicha(starterNames[1], "Curiosa e competitiva.", "Saiu de casa para pesquisar Pokémon raros."),
      ),
    );
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$confirmar"));
    const submitMessage = incoming(PLAYER_JID, RECEPTION_CHAT, "$confirmar sim");
    await receive(runtime.service, submitMessage);
    const replay = unwrap("replay exact submit", await runtime.service.receive(submitMessage));
    assert.equal(replay.status, "REPLAYED");

    const firstReviews = await pool.query<{
      id: string;
      sequence_no: number;
      status: string;
      revision: number;
      snapshot_json: { starterFormId: string };
    }>(
      `SELECT id, sequence_no, status, revision, snapshot_json
       FROM registration_revisions WHERE player_id = $1 ORDER BY sequence_no`,
      [playerId],
    );
    assert.equal(firstReviews.rows.length, 1);
    const firstReview = firstReviews.rows[0];
    if (firstReview === undefined) throw new Error("First submitted review is missing");
    assert.equal(firstReview.sequence_no, 1);
    assert.equal(firstReview.status, "SUBMITTED");

    const setup = unwrap("reload registration setup", await new PostgresRegistrationSetupLoader(pool).load());
    const expectedStarter = setup.starterOptions.find((option) => option.displayName === starterNames[1]);
    if (expectedStarter === undefined) throw new Error("Changed starter is absent from setup");
    assert.equal(firstReview.snapshot_json.starterFormId, expectedStarter.formId);

    const notification = await pool.query<{ payload: { mentions?: string[]; registrationReview?: unknown } }>(
      `SELECT payload
       FROM outbox_messages
       WHERE payload ? 'registrationReview'
         AND payload -> 'registrationReview' ->> 'reviewId' = $1`,
      [firstReview.id],
    );
    assert.equal(notification.rows.length, 1);
    assert.deepEqual(notification.rows[0]?.payload.mentions, [ADMIN_JID]);

    const adapter = new FakeWhatsAppAdapter();
    const outboxWorker = createOperationalOutboxWorker(pool, runtime.repository, adapter);
    await outboxWorker.runOnce();
    const firstAnchor = await pool.query<{ provider_external_message_id: string }>(
      `SELECT provider_external_message_id
       FROM registration_message_refs
       WHERE review_id = $1 AND review_revision = $2`,
      [firstReview.id, firstReview.revision],
    );
    const firstReplyId = firstAnchor.rows[0]?.provider_external_message_id;
    if (firstReplyId === undefined) throw new Error("First review reply anchor was not persisted");

    await receive(
      runtime.service,
      incoming(ADMIN_JID, RECEPTION_CHAT, "$ajustes", firstReplyId),
    );
    const changed = await pool.query<{ status: string }>(
      "SELECT status FROM registration_revisions WHERE id = $1",
      [firstReview.id],
    );
    assert.equal(changed.rows[0]?.status, "CHANGES_REQUESTED");

    const firstDraft = await pool.query<{ trainer_name: string; starter_form_id: string }>(
      "SELECT trainer_name, starter_form_id FROM registration_drafts WHERE player_id = $1",
      [playerId],
    );
    assert.equal(firstDraft.rows[0]?.trainer_name, "Liora Vale");
    assert.equal(firstDraft.rows[0]?.starter_form_id, expectedStarter.formId);

    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$editar"));
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$modo completo"));
    await receive(
      runtime.service,
      incoming(
        PLAYER_JID,
        RECEPTION_CHAT,
        fullFicha(
          starterNames[1],
          "Curiosa, competitiva e mais cautelosa após a revisão.",
          "Saiu de casa para pesquisar Pokémon raros.",
        ),
      ),
    );
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$confirmar"));
    await receive(runtime.service, incoming(PLAYER_JID, RECEPTION_CHAT, "$confirmar sim"));

    const reviews = await pool.query<{
      id: string;
      sequence_no: number;
      status: string;
      revision: number;
      snapshot_json: { trainerName: string; personality: string; starterFormId: string };
    }>(
      `SELECT id, sequence_no, status, revision, snapshot_json
       FROM registration_revisions WHERE player_id = $1 ORDER BY sequence_no`,
      [playerId],
    );
    assert.equal(reviews.rows.length, 2);
    const secondReview = reviews.rows[1];
    if (secondReview === undefined) throw new Error("Second submitted review is missing");
    assert.equal(secondReview.sequence_no, 2);
    assert.equal(secondReview.status, "SUBMITTED");
    assert.equal(secondReview.snapshot_json.trainerName, "Liora Vale");
    assert.equal(secondReview.snapshot_json.starterFormId, expectedStarter.formId);
    assert.match(secondReview.snapshot_json.personality, /mais cautelosa/);

    await outboxWorker.runOnce();
    const secondAnchor = await pool.query<{ provider_external_message_id: string }>(
      `SELECT provider_external_message_id
       FROM registration_message_refs
       WHERE review_id = $1 AND review_revision = $2`,
      [secondReview.id, secondReview.revision],
    );
    const secondReplyId = secondAnchor.rows[0]?.provider_external_message_id;
    if (secondReplyId === undefined) throw new Error("Second review reply anchor was not persisted");

    await receive(
      runtime.service,
      incoming(ADMIN_JID, RECEPTION_CHAT, "$aprovar", secondReplyId),
    );
    const approved = await pool.query<{ status: string; decided_by_admin_principal_id: string }>(
      `SELECT status, decided_by_admin_principal_id
       FROM registration_revisions WHERE id = $1`,
      [secondReview.id],
    );
    assert.equal(approved.rows[0]?.status, "APPROVED");
    assert.equal(approved.rows[0]?.decided_by_admin_principal_id, adminPrincipalId);

    const audit = await pool.query<{ metadata: { sourceChannel?: string }; target_type: string }>(
      `SELECT metadata, target_type
       FROM audit_events
       WHERE action = 'registration.review.approve'
         AND target_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [secondReview.id],
    );
    assert.equal(audit.rows[0]?.target_type, "REGISTRATION_REVIEW");
    assert.equal(audit.rows[0]?.metadata.sourceChannel, "WHATSAPP");

    const registrationRepository = new PostgresRegistrationRepository(pool);
    const accessRepository = new PostgresPlayerAccessRepository(pool);
    const playerRepository = new PostgresPlayerOnboardingRepository(pool);
    const realRegistration = new PlayerRegistrationService(playerRepository);
    const realStarter = new PlayerStarterService(playerRepository, new SystemClock(), new CryptoRandomSource());
    const realWorld = new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null });
    const candidateSource = new PostgresProvisioningCandidateSource(pool);

    const failingProvisioning = new PlayerProvisioningService(
      registrationRepository,
      accessRepository,
      {
        createProfile: async () => err(appError("FEATURE_UNAVAILABLE", "proof pause after PROVISIONING")),
        selectRegion: (id, input) => realRegistration.selectRegion(id, input),
      },
      realStarter,
      realWorld,
      new PostgresReceptionActivationAnnouncement(pool),
    );
    const firstMaintenance = await new PlayerProvisioningWorker(
      candidateSource,
      failingProvisioning,
    ).runOnce();
    assert.equal(firstMaintenance.failed, 1);
    const provisioningAccess = await pool.query<{ status: string }>(
      "SELECT status FROM player_access WHERE player_id = $1",
      [playerId],
    );
    assert.equal(provisioningAccess.rows[0]?.status, "PROVISIONING");

    const realProvisioning = new PlayerProvisioningService(
      registrationRepository,
      accessRepository,
      realRegistration,
      realStarter,
      realWorld,
      new PostgresReceptionActivationAnnouncement(pool),
    );
    const finalMaintenance = await new PlayerProvisioningWorker(
      candidateSource,
      realProvisioning,
    ).runOnce();
    assert.equal(finalMaintenance.activated, 1);

    const materialized = await pool.query<{
      access_status: string;
      onboarding_state: string;
      origin_region_id: string;
      trainer_name: string;
      starter_count: number;
      location_count: number;
    }>(
      `SELECT access.status AS access_status,
              onboarding.state AS onboarding_state,
              profile.origin_region_id,
              profile.trainer_name,
              (SELECT count(*)::integer FROM starter_grants grant_row WHERE grant_row.player_id = player.id) AS starter_count,
              (SELECT count(*)::integer FROM player_locations location WHERE location.player_id = player.id) AS location_count
       FROM players player
       JOIN player_access access ON access.player_id = player.id
       JOIN onboarding_states onboarding ON onboarding.player_id = player.id
       JOIN player_profiles profile ON profile.player_id = player.id
       WHERE player.id = $1`,
      [playerId],
    );
    assert.deepEqual(materialized.rows[0], {
      access_status: "ACTIVE",
      onboarding_state: "COMPLETE",
      origin_region_id: regionId,
      trainer_name: "Liora Vale",
      starter_count: 1,
      location_count: 1,
    });

    const announcement = await pool.query<{ status: string; destination_ref: string; payload: { text?: string } }>(
      `SELECT status, destination_ref, payload
       FROM outbox_messages
       WHERE idempotency_key = $1`,
      [`registration-activated:${secondReview.id}:${(await pool.query<{ id: string }>("SELECT id FROM community_groups WHERE chat_ref = $1", [RECEPTION_CHAT])).rows[0]?.id}`],
    );
    assert.equal(announcement.rows[0]?.status, "PENDING");
    assert.equal(announcement.rows[0]?.destination_ref, RECEPTION_CHAT);
    assert.match(announcement.rows[0]?.payload.text ?? "", /Liora Vale/);

    const location = unwrap("load active location", await realWorld.getLocation(playerId as never));
    const route = location.connections.find((candidate) => candidate.destinationSlug === "zhoulia-road");
    if (route === undefined) throw new Error("Zhoulia world route is missing after provisioning");
    const commandText = `$ir ${route.destinationSlug} v${location.revision}`;
    const receptionContext = directContext(PLAYER_JID, RECEPTION_CHAT, commandText);
    const denied = await runtime.composition.router.dispatch(receptionContext);
    assert.equal(denied.ok, false);
    if (denied.ok) throw new Error("World travel unexpectedly passed in Reception");

    const worldContext = directContext(PLAYER_JID, WORLD_CHAT, commandText);
    const allowed = await runtime.composition.router.dispatch(worldContext);
    assert.equal(allowed.ok, true);
    if (!allowed.ok) throw new Error(`World travel was denied in world-capable group: ${allowed.error.code}`);
    assert.match(
      String(allowed.value?.outgoing[0]?.payload.text ?? ""),
      /Estrada de Zhoulia/,
    );

    console.log("Reception registration E2E proof passed");
  } finally {
    await pool.end();
  }
}

function directContext(senderRef: string, chatRef: string, text: string): MessageHandlerContext {
  const inboxMessageId = randomUUID();
  return {
    inboxMessageId,
    correlationId: randomUUID(),
    causationId: inboxMessageId,
    idempotencyKey: `reception-e2e-direct:${randomUUID()}`,
    message: incoming(senderRef, chatRef, text),
  };
}

void main();
