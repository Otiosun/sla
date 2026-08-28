import { Pool } from "pg";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { OnboardingMessageRouter } from "../../src/modules/messaging/onboarding-router.js";
import { MessagingService } from "../../src/modules/messaging/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { IncomingMessageSchema, type IncomingMessage } from "../../src/modules/messaging/contracts.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 13 onboarding UX proof");
}

function message(input: {
  readonly id: string;
  readonly sender: string;
  readonly chat?: string;
  readonly text: string;
}): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: "phase13-onboarding",
    externalMessageId: input.id,
    senderRef: input.sender,
    chatRef: input.chat ?? input.sender,
    occurredAt: "2026-08-28T01:30:00-03:00",
    text: input.text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  });
}

function buildService(pool: Pool): MessagingService {
  const playerRepository = new PostgresPlayerOnboardingRepository(pool);
  const registration = new PlayerRegistrationService(playerRepository);
  const starter = new PlayerStarterService(
    playerRepository,
    new ManualClock(new Date("2026-08-28T04:30:00.000Z")),
    new DeterministicRandomSource(13_005),
  );
  const router = new OnboardingMessageRouter(registration, starter, new MessageRouter());
  return new MessagingService(new PostgresMessagingRepository(pool), router, 30_000);
}

async function outboxText(pool: Pool, inboxMessageId: string): Promise<string | null> {
  const result = await pool.query<{ text: string }>(
    `SELECT payload->>'text' AS text
     FROM outbox_messages
     WHERE causation_id = $1
     ORDER BY created_at, id
     LIMIT 1`,
    [inboxMessageId],
  );
  return result.rows[0]?.text ?? null;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const activeRelease = await pool.query<{ release_no: string; starter_count: string }>(
      `SELECT
         release.release_no::text AS release_no,
         (SELECT count(*)::text
          FROM starter_options starter
          WHERE starter.content_release_id = release.id AND starter.active = TRUE) AS starter_count
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id = pointer.content_release_id
       WHERE pointer.pointer_key = 'ACTIVE'`,
    );
    if (
      activeRelease.rows[0]?.release_no !== "2" ||
      activeRelease.rows[0]?.starter_count !== "3"
    ) {
      throw new Error(`Phase 5 onboarding catalog is not active: ${JSON.stringify(activeRelease.rows[0])}`);
    }

    let service = buildService(pool);

    const groupFree = await service.receive(
      message({
        id: "group-free",
        sender: "group-player",
        chat: "group-room",
        text: "Charmander observa a rua enquanto a cena continua.",
      }),
    );
    if (!groupFree.ok || groupFree.value.status !== "PROCESSED") {
      throw new Error(`Group freeform did not pass safely: ${JSON.stringify(groupFree)}`);
    }
    if ((await outboxText(pool, groupFree.value.inboxMessageId)) !== null) {
      throw new Error("Group freeform triggered onboarding output");
    }

    const groupStart = await service.receive(
      message({ id: "group-start", sender: "group-player", chat: "group-room", text: "$começar" }),
    );
    if (!groupStart.ok || groupStart.value.status !== "PROCESSED") {
      throw new Error(`Group onboarding handoff failed: ${JSON.stringify(groupStart)}`);
    }
    const groupHandoff = await outboxText(pool, groupStart.value.inboxMessageId);
    if (groupHandoff === null || !groupHandoff.toLocaleLowerCase("pt-BR").includes("privado")) {
      throw new Error(`Group onboarding did not hand off to private: ${String(groupHandoff)}`);
    }
    const groupIdentityCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM player_identities
       WHERE provider = 'phase13-onboarding' AND external_id = 'group-player'`,
    );
    if (groupIdentityCount.rows[0]?.count !== "0") {
      throw new Error("Group onboarding silently created a player");
    }

    const firstContact = await service.receive(
      message({ id: "direct-hello", sender: "direct-player", text: "oi" }),
    );
    if (!firstContact.ok || firstContact.value.status !== "PROCESSED") {
      throw new Error(`Direct first-contact prompt failed: ${JSON.stringify(firstContact)}`);
    }
    const firstText = await outboxText(pool, firstContact.value.inboxMessageId);
    if (firstText === null || !firstText.includes("COMEÇAR")) {
      throw new Error(`Direct first contact did not offer COMEÇAR: ${String(firstText)}`);
    }
    const beforeConsent = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM player_identities
       WHERE provider = 'phase13-onboarding' AND external_id = 'direct-player'`,
    );
    if (beforeConsent.rows[0]?.count !== "0") {
      throw new Error("Direct first contact created a player before explicit consent");
    }

    const startedMessage = message({ id: "direct-start", sender: "direct-player", text: "$começar" });
    const started = await service.receive(startedMessage);
    const startedReplay = await service.receive(startedMessage);
    if (
      !started.ok ||
      started.value.status !== "PROCESSED" ||
      !startedReplay.ok ||
      startedReplay.value.status !== "REPLAYED"
    ) {
      throw new Error("Onboarding start was not Inbox-idempotent");
    }
    const startedState = await pool.query<{ player_id: string; state: string; count: string }>(
      `SELECT identity.player_id::text,
              onboarding.state,
              (SELECT count(*)::text
               FROM player_identities duplicate
               WHERE duplicate.provider = identity.provider
                 AND duplicate.external_id = identity.external_id) AS count
       FROM player_identities identity
       JOIN onboarding_states onboarding ON onboarding.player_id = identity.player_id
       WHERE identity.provider = 'phase13-onboarding' AND identity.external_id = 'direct-player'`,
    );
    const playerId = startedState.rows[0]?.player_id;
    if (
      playerId === undefined ||
      startedState.rows[0]?.state !== "NEW" ||
      startedState.rows[0]?.count !== "1"
    ) {
      throw new Error(`Onboarding start state mismatch: ${JSON.stringify(startedState.rows[0])}`);
    }

    const named = await service.receive(
      message({ id: "direct-name", sender: "direct-player", text: "Red" }),
    );
    if (!named.ok || named.value.status !== "PROCESSED") {
      throw new Error(`Trainer name step failed: ${JSON.stringify(named)}`);
    }
    const regionText = await outboxText(pool, named.value.inboxMessageId);
    if (regionText === null || !regionText.includes("Kanto")) {
      throw new Error(`Region projection did not render pinned Kanto: ${String(regionText)}`);
    }
    const afterName = await pool.query<{ state: string; trainer_name: string }>(
      `SELECT onboarding.state, profile.trainer_name
       FROM onboarding_states onboarding
       JOIN player_profiles profile ON profile.player_id = onboarding.player_id
       WHERE onboarding.player_id = $1`,
      [playerId],
    );
    if (afterName.rows[0]?.state !== "PROFILE_CREATED" || afterName.rows[0]?.trainer_name !== "Red") {
      throw new Error(`Profile step did not persist correctly: ${JSON.stringify(afterName.rows[0])}`);
    }

    const invalidRegion = await service.receive(
      message({ id: "direct-region-invalid", sender: "direct-player", text: "99" }),
    );
    if (!invalidRegion.ok || invalidRegion.value.status !== "PROCESSED") {
      throw new Error(`Invalid region was not handled as UX: ${JSON.stringify(invalidRegion)}`);
    }
    const invalidRegionState = await pool.query<{ state: string; origin_region_id: string | null }>(
      `SELECT onboarding.state, profile.origin_region_id
       FROM onboarding_states onboarding
       JOIN player_profiles profile ON profile.player_id = onboarding.player_id
       WHERE onboarding.player_id = $1`,
      [playerId],
    );
    if (
      invalidRegionState.rows[0]?.state !== "PROFILE_CREATED" ||
      invalidRegionState.rows[0]?.origin_region_id !== null
    ) {
      throw new Error("Invalid region mutated onboarding state");
    }

    const regionSelected = await service.receive(
      message({ id: "direct-region", sender: "direct-player", text: "1" }),
    );
    if (!regionSelected.ok || regionSelected.value.status !== "PROCESSED") {
      throw new Error(`Region selection failed: ${JSON.stringify(regionSelected)}`);
    }
    const starterText = await outboxText(pool, regionSelected.value.inboxMessageId);
    if (
      starterText === null ||
      !starterText.includes("Bulbasaur") ||
      !starterText.includes("Charmander") ||
      !starterText.includes("Squirtle")
    ) {
      throw new Error(`Starter menu is incomplete: ${String(starterText)}`);
    }
    const pending = await pool.query<{ state: string; origin_slug: string }>(
      `SELECT onboarding.state, region.slug AS origin_slug
       FROM onboarding_states onboarding
       JOIN player_profiles profile ON profile.player_id = onboarding.player_id
       JOIN regions region ON region.id = profile.origin_region_id
       WHERE onboarding.player_id = $1`,
      [playerId],
    );
    if (pending.rows[0]?.state !== "STARTER_PENDING" || pending.rows[0]?.origin_slug !== "kanto") {
      throw new Error(`Region/starter preparation mismatch: ${JSON.stringify(pending.rows[0])}`);
    }

    service = buildService(pool);
    const invalidStarter = await service.receive(
      message({ id: "direct-starter-invalid", sender: "direct-player", text: "99" }),
    );
    if (!invalidStarter.ok || invalidStarter.value.status !== "PROCESSED") {
      throw new Error(`Invalid starter was not handled as UX: ${JSON.stringify(invalidStarter)}`);
    }
    const noGrant = await pool.query<{ state: string; grants: string }>(
      `SELECT onboarding.state,
              (SELECT count(*)::text FROM starter_grants grant_row WHERE grant_row.player_id = onboarding.player_id) AS grants
       FROM onboarding_states onboarding
       WHERE onboarding.player_id = $1`,
      [playerId],
    );
    if (noGrant.rows[0]?.state !== "STARTER_PENDING" || noGrant.rows[0]?.grants !== "0") {
      throw new Error("Invalid starter mutated durable state");
    }

    const starterMessage = message({ id: "direct-starter", sender: "direct-player", text: "2" });
    const starterChosen = await service.receive(starterMessage);
    const starterReplay = await service.receive(starterMessage);
    if (
      !starterChosen.ok ||
      starterChosen.value.status !== "PROCESSED" ||
      !starterReplay.ok ||
      starterReplay.value.status !== "REPLAYED"
    ) {
      throw new Error("Starter selection was not Inbox-idempotent");
    }
    const completedText = await outboxText(pool, starterChosen.value.inboxMessageId);
    if (completedText === null || !completedText.includes("Charmander")) {
      throw new Error(`Completion UX lost selected starter: ${String(completedText)}`);
    }
    const completed = await pool.query<{
      state: string;
      grants: string;
      pokemon: string;
      team: string;
      caught: string;
    }>(
      `SELECT onboarding.state,
              (SELECT count(*)::text FROM starter_grants grant_row WHERE grant_row.player_id = onboarding.player_id) AS grants,
              (SELECT count(*)::text FROM pokemon_instances pokemon WHERE pokemon.owner_player_id = onboarding.player_id) AS pokemon,
              (SELECT count(*)::text FROM pokemon_roster_slots roster WHERE roster.player_id = onboarding.player_id AND roster.placement_kind = 'TEAM') AS team,
              (SELECT COALESCE(sum(caught_count), 0)::text FROM player_pokedex_species dex WHERE dex.player_id = onboarding.player_id) AS caught
       FROM onboarding_states onboarding
       WHERE onboarding.player_id = $1`,
      [playerId],
    );
    if (
      completed.rows[0]?.state !== "COMPLETE" ||
      completed.rows[0]?.grants !== "1" ||
      completed.rows[0]?.pokemon !== "1" ||
      completed.rows[0]?.team !== "1" ||
      completed.rows[0]?.caught !== "1"
    ) {
      throw new Error(`Completed onboarding invariant mismatch: ${JSON.stringify(completed.rows[0])}`);
    }

    const postCompleteFree = await service.receive(
      message({
        id: "direct-free-after-complete",
        sender: "direct-player",
        text: "Charmander olha para Red antes de seguirem viagem.",
      }),
    );
    if (!postCompleteFree.ok || postCompleteFree.value.status !== "PROCESSED") {
      throw new Error("Post-onboarding free scene did not return to downstream router");
    }
    if ((await outboxText(pool, postCompleteFree.value.inboxMessageId)) !== null) {
      throw new Error("Completed onboarding intercepted a free campaign scene");
    }

    const secondStart = await service.receive(
      message({ id: "second-start", sender: "second-player", text: "$começar" }),
    );
    if (!secondStart.ok || secondStart.value.status !== "PROCESSED") {
      throw new Error("Could not create second incomplete onboarding fixture");
    }
    const secondPlayer = await pool.query<{ player_id: string; state: string }>(
      `SELECT identity.player_id::text, onboarding.state
       FROM player_identities identity
       JOIN onboarding_states onboarding ON onboarding.player_id = identity.player_id
       WHERE identity.provider = 'phase13-onboarding' AND identity.external_id = 'second-player'`,
    );
    const incompleteGroup = await service.receive(
      message({ id: "second-group-menu", sender: "second-player", chat: "second-group", text: "$menu" }),
    );
    if (!incompleteGroup.ok || incompleteGroup.value.status !== "PROCESSED") {
      throw new Error("Incomplete player group handoff failed");
    }
    const secondAfter = await pool.query<{ state: string }>(
      "SELECT state FROM onboarding_states WHERE player_id = $1",
      [secondPlayer.rows[0]?.player_id],
    );
    if (
      secondPlayer.rows[0]?.state !== "NEW" ||
      secondAfter.rows[0]?.state !== "NEW" ||
      !(await outboxText(pool, incompleteGroup.value.inboxMessageId))?.includes("privado")
    ) {
      throw new Error("Group handoff mutated or exposed incomplete onboarding");
    }

    console.log(
      "Phase 13 onboarding UX E2E complete: private consent/state menus, group handoff, restart and duplicate safety are proven",
    );
  } finally {
    await pool.end();
  }
}

await main();
