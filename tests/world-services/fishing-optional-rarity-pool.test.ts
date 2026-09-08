import { describe, expect, it, vi } from "vitest";
import type { RandomSource } from "../../src/platform/rng/index.js";
import { FishingService } from "../../src/modules/world-services/fishing-service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const PLAYER_ID = createPlayerId();

function rng(roll: number): RandomSource {
  return {
    randomFloat: () => 0,
    randomInt: vi.fn(() => roll - 1),
  };
}

describe("Fishing optional administration rarity pools", () => {
  it("consumes a RARE attempt without creating an encounter when that area has no ADM rare pool", async () => {
    const reserveAttempt = vi.fn(async () => ({
      kind: "RESERVED" as const,
      attemptId: "00000000-0000-4000-8000-000000004101",
      playerId: PLAYER_ID,
      areaId: "00000000-0000-4000-8000-000000004102",
      fishingPointName: "Rio dos Arrozais",
      attemptNo: 1,
      dailyLimit: 5,
      remainingAttempts: 4,
      roll: 18,
      rarity: "RARE" as const,
      encounterTableSlug: null,
      replayed: false,
    }));
    const createOrReplay = vi.fn();
    const service = new FishingService({ reserveAttempt }, { createOrReplay }, rng(18));

    const result = await service.attempt({
      playerId: PLAYER_ID,
      idempotencyKey: "fish-rare-without-admin-pool",
    });

    expect(createOrReplay).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      value: {
        roll: 18,
        rarity: "RARE",
        attemptNo: 1,
        remainingAttempts: 4,
        encounter: null,
      },
    });
  });
});
