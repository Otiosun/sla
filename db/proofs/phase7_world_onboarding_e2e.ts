import { Pool } from "pg";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import { createCorrelationId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 7 onboarding/world E2E proof");
}

function unwrap<T>(label: string, result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const regions = await pool.query<{ id: string; slug: string }>(
      `SELECT region.id,region.slug
         FROM region_revisions revision
         JOIN regions region ON region.id=revision.region_id
         JOIN content_release_pointers pointer
           ON pointer.content_release_id=revision.content_release_id
        WHERE pointer.pointer_key='ACTIVE'
          AND revision.active=TRUE
        ORDER BY region.slug`,
    );
    if (
      regions.rows.length !== 1 ||
      regions.rows[0]?.slug !== "zhoulia" ||
      regions.rows[0]?.id === undefined
    ) {
      throw new Error(`ACTIVE world must expose only Zhoulia: ${JSON.stringify(regions.rows)}`);
    }
    const regionId = regions.rows[0].id;

    const onboardingRepository = new PostgresPlayerOnboardingRepository(pool);
    const registration = new PlayerRegistrationService(onboardingRepository);
    const clock = new ManualClock(new Date("2026-09-19T00:00:00.000Z"));
    const starter = new PlayerStarterService(
      onboardingRepository,
      clock,
      new DeterministicRandomSource(7007),
    );

    const identity = unwrap(
      "resolve/create player",
      await registration.resolveOrCreatePlayer({
        provider: "phase7-proof",
        externalId: "onboarding-to-zhoulia-e2e",
      }),
    );
    unwrap(
      "create profile",
      await registration.createProfile(identity.playerId, {
        trainerName: "World E2E",
        locale: "pt-BR",
      }),
    );
    unwrap("select Zhoulia", await registration.selectRegion(identity.playerId, { regionId }));
    const selection = unwrap(
      "prepare starter",
      await starter.prepareStarterSelection(identity.playerId),
    );
    const starterOption = selection.options[0];
    if (starterOption === undefined) throw new Error("Zhoulia has no active starter option");
    unwrap(
      "grant starter",
      await starter.grantStarter(
        identity.playerId,
        { formId: starterOption.formId },
        createCorrelationId(),
      ),
    );
    unwrap("complete onboarding", await starter.completeOnboarding(identity.playerId));
    const profile = unwrap("load completed profile", await starter.getProfile(identity.playerId));
    if (profile.onboardingState !== "COMPLETE") {
      throw new Error(`Expected COMPLETE onboarding, got ${profile.onboardingState}`);
    }

    const world = new WorldService(
      new PostgresWorldRepository(pool),
      { enabled: true, reason: null },
      clock,
    );
    const initial = unwrap(
      "initialize world location",
      await world.ensureInitialLocation({ playerId: identity.playerId }),
    );
    if (
      initial.regionSlug !== "zhoulia" ||
      initial.areaSlug !== "vila-dos-arrozais" ||
      initial.revision !== 0n
    ) {
      throw new Error(
        `Expected Zhoulia/Vila dos Arrozais revision 0, got ` +
          `${initial.regionSlug}/${initial.areaSlug} revision ${initial.revision}`,
      );
    }

    const route = initial.connections.find(
      (connection) =>
        connection.destinationSlug === "campos-de-yun" &&
        connection.destinationDisplayName === "Campos de Yun" &&
        connection.available,
    );
    if (route === undefined) {
      throw new Error("Vila dos Arrozais has no available canonical Campos de Yun route");
    }

    const traveled = unwrap(
      "travel to Campos de Yun",
      await world.travel({
        playerId: identity.playerId,
        destinationAreaId: route.destinationAreaId,
        expectedRevision: initial.revision,
      }),
    );
    if (
      traveled.to.regionSlug !== "zhoulia" ||
      traveled.to.areaSlug !== "campos-de-yun" ||
      traveled.to.revision !== 1n
    ) {
      throw new Error(
        `Expected Campos de Yun revision 1, got ` +
          `${traveled.to.regionSlug}/${traveled.to.areaSlug} revision ${traveled.to.revision}`,
      );
    }

    const local = unwrap("query persisted location", await world.getLocation(identity.playerId));
    if (
      local.regionSlug !== "zhoulia" ||
      local.areaSlug !== "campos-de-yun" ||
      local.revision !== 1n
    ) {
      throw new Error(
        `Persisted location mismatch: ${local.regionSlug}/${local.areaSlug} revision ${local.revision}`,
      );
    }

    console.log(
      `Phase 7 Zhoulia E2E complete: player ${identity.playerId} -> ` +
        `${initial.areaSlug} -> ${local.areaSlug}`,
    );
  } finally {
    await pool.end();
  }
}

await main();
