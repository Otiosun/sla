import { describe, expect, it } from "vitest";
import type { WorldAreaRecord } from "../../src/modules/world/contracts.js";
import type { WorldRepository, WorldTransaction } from "../../src/modules/world/ports.js";
import { WorldService } from "../../src/modules/world/service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const PLAYER_ID = createPlayerId();
const RELEASE_ID = "00000000-0000-4000-8000-000000003101";
const AREA_ID = "00000000-0000-4000-8000-000000003102";
const REGION_ID = "00000000-0000-4000-8000-000000003103";

function transaction(): WorldTransaction {
  const area: WorldAreaRecord = {
    areaId: AREA_ID,
    areaSlug: "vila-dos-arrozais",
    areaDisplayName: "Vila dos Arrozais",
    regionId: REGION_ID,
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    active: true,
    config: {
      schemaVersion: 1,
      kind: "TOWN",
      safePoint: true,
      startingArea: true,
      relocationPriority: 0,
      facilities: ["POKEMART", "POKEMON_CENTER"],
    } as unknown as WorldAreaRecord["config"],
  };

  return {
    activeContentReleaseId: async () => RELEASE_ID,
    playerEligibility: async () => ({
      playerActive: true,
      onboardingComplete: true,
      originRegionId: REGION_ID,
    }),
    playerLocation: async () => ({
      playerId: PLAYER_ID,
      areaId: AREA_ID,
      enteredAt: new Date("2026-09-08T16:00:00.000Z"),
      revision: 0n,
    }),
    insertInitialLocation: async () => true,
    moveLocation: async () => null,
    acquireTravelIdempotencyLock: async () => undefined,
    travelReceipt: async () => null,
    insertTravelReceipt: async () => undefined,
    area: async () => area,
    areasInRegion: async () => [area],
    connectionsFrom: async () => [],
    connectionBetween: async () => null,
    activeFlowState: async () => ({ encounterActive: false, battleActive: false }),
    activeUnlockKeys: async () => [],
  };
}

function repository(): WorldRepository {
  const tx = transaction();
  return {
    read: async (work) => work(tx),
    transaction: async (work) => work(tx),
  };
}

describe("World location facility authority", () => {
  it("projects content-defined area facilities into the runtime location view", async () => {
    const world = new WorldService(repository(), { enabled: true, reason: null });

    const result = await world.getLocation(PLAYER_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { facilities?: unknown }).facilities).toEqual([
      "POKEMART",
      "POKEMON_CENTER",
    ]);
  });
});
