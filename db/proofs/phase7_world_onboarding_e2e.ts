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
    const region = await pool.query<{ id: string }>("SELECT id FROM regions WHERE slug = 'kanto'");
    const regionId = region.rows[0]?.id;
    if (regionId === undefined) throw new Error("Kanto is missing from the active seeded catalog");

    const onboardingRepository = new PostgresPlayerOnboardingRepository(pool);
    const registration = new PlayerRegistrationService(onboardingRepository);
    const starter = new PlayerStarterService(
      onboardingRepository,
      new ManualClock(new Date("2026-08-26T00:00:00.000Z")),
      new DeterministicRandomSource(7007),
    );

    const identity = unwrap(
      "resolve/create player",
      await registration.resolveOrCreatePlayer({
        provider: "phase7-proof",
        externalId: "onboarding-to-world-e2e",
      }),
    );
    unwrap(
      "create profile",
      await registration.createProfile(identity.playerId, {
        trainerName: "World E2E",
        locale: "pt-BR",
      }),
    );
    unwrap(
      "select Kanto",
      await registration.selectRegion(identity.playerId, { regionId }),
    );
    const selection = unwrap(
      "prepare starter",
      await starter.prepareStarterSelection(identity.playerId),
    );
    const starterOption = selection.options[0];
    if (starterOption === undefined) throw new Error("Kanto has no active starter option");
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

    const world = new WorldService(new PostgresWorldRepository(pool), {
      enabled: true,
      reason: null,
    });
    const initial = unwrap(
      "initialize world location",
      await world.ensureInitialLocation({ playerId: identity.playerId }),
    );
    if (initial.areaSlug !== "pallet-town" || initial.revision !== 0n) {
      throw new Error(
        `Expected Pallet Town revision 0, got ${initial.areaSlug} revision ${initial.revision}`,
      );
    }

    const route = initial.connections.find(
      (connection) => connection.destinationSlug === "route-1" && connection.available,
    );
    if (route === undefined) throw new Error("Pallet Town has no available Route 1 connection");
    const traveled = unwrap(
      "travel to Route 1",
      await world.travel({
        playerId: identity.playerId,
        destinationAreaId: route.destinationAreaId,
        expectedRevision: initial.revision,
      }),
    );
    if (traveled.to.areaSlug !== "route-1" || traveled.to.revision !== 1n) {
      throw new Error(
        `Expected Route 1 revision 1, got ${traveled.to.areaSlug} revision ${traveled.to.revision}`,
      );
    }

    const local = unwrap("query persisted location", await world.getLocation(identity.playerId));
    if (local.areaSlug !== "route-1" || local.revision !== 1n) {
      throw new Error(
        `Persisted location mismatch: ${local.areaSlug} revision ${local.revision}`,
      );
    }

    console.log(
      `Phase 7 E2E complete: player ${identity.playerId} -> ${initial.areaSlug} -> ${local.areaSlug}`,
    );
  } finally {
    await pool.end();
  }
}

await main();
