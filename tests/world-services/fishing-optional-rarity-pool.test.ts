import { describe, expect, it, vi } from "vitest";
import type { RandomSource } from "../../src/platform/rng/index.js";
import {
  FishingService,
  type FishingRarity,
} from "../../src/modules/world-services/fishing-service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const PLAYER_ID = createPlayerId();

function rng(roll: number): RandomSource {
  return {
    randomFloat: () => 0,
    randomInt: vi.fn(() => roll - 1),
  };
}

describe("Fishing administration rarity pool integrity", () => {
  it.each([
    { roll: 18, rarity: "RARE" as FishingRarity },
    { roll: 20, rarity: "EXTREMELY_RARE" as FishingRarity },
  ])("rejects a $rarity reservation without an encounter pool", async ({ roll, rarity }) => {
    const reserveAttempt = vi.fn(async () => ({
      kind: "RESERVED" as const,
      attemptId: `00000000-0000-4000-8000-0000000041${roll}`,
      playerId: PLAYER_ID,
      areaId: "00000000-0000-4000-8000-000000004102",
      fishingPointName: "Rio dos Arrozais",
      attemptNo: 1,
      dailyLimit: 5,
      remainingAttempts: 4,
      roll,
      rarity,
      encounterTableSlug: null,
      replayed: false,
    }));
    const createOrReplay = vi.fn();
    const service = new FishingService({ reserveAttempt }, { createOrReplay }, rng(roll));

    const result = await service.attempt({
      playerId: PLAYER_ID,
      idempotencyKey: `fish-${rarity.toLowerCase()}-without-admin-pool`,
    });

    expect(createOrReplay).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: "Fishing rarity has no configured encounter table",
        details: { rarity },
      },
    });
  });
});
