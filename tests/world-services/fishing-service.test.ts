import { describe, expect, it, vi } from "vitest";
import type { EncounterView } from "../../src/modules/encounter/contracts.js";
import {
  FishingService,
  fishingRarityForRoll,
  type FishingAttemptReserved,
  type FishingDailyLimitReached,
} from "../../src/modules/world-services/fishing-service.js";
import { createEncounterId, createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";
import type { RandomSource } from "../../src/platform/rng/index.js";

const PLAYER_ID = createPlayerId();
const ATTEMPT_ID = "00000000-0000-4000-8000-000000004001";
const AREA_ID = "00000000-0000-4000-8000-000000004002";
const ENCOUNTER_ID = createEncounterId();

function rng(roll: number): RandomSource {
  return {
    randomFloat: () => 0,
    randomInt: vi.fn(() => roll - 1),
  };
}

function encounterView(): EncounterView {
  return {
    encounterId: ENCOUNTER_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    status: "CREATED",
    contentReleaseId: "00000000-0000-4000-8000-000000004003",
    rulesetId: "00000000-0000-4000-8000-000000004004",
    creationIdempotencyKey: "encounter.create:fishing-test",
    rngCounter: 0n,
    revision: 0n,
    createdAt: new Date("2026-09-07T21:00:00.000Z"),
    updatedAt: new Date("2026-09-07T21:00:00.000Z"),
    expiresAt: new Date("2026-09-07T21:10:00.000Z"),
    closedAt: null,
    battleId: null,
    snapshot: {
      schemaVersion: 1,
      formId: "00000000-0000-4000-8000-000000004005",
      speciesId: "00000000-0000-4000-8000-000000004006",
      level: 8,
      type1Id: "00000000-0000-4000-8000-000000004007",
      type2Id: null,
      baseStats: { hp: 55, attack: 45, defense: 45, spAttack: 25, spDefense: 25, speed: 15 },
      ivs: { hp: 1, attack: 2, defense: 3, spAttack: 4, spDefense: 5, speed: 6 },
      natureId: "00000000-0000-4000-8000-000000004008",
      abilityId: "00000000-0000-4000-8000-000000004009",
      moves: [],
      maxHp: 24,
      currentHp: 24,
      shiny: false,
      gender: null,
    },
  };
}

function reservation(overrides: Partial<FishingAttemptReserved> = {}): FishingAttemptReserved {
  return {
    kind: "RESERVED",
    attemptId: ATTEMPT_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    fishingPointName: "Rio dos Arrozais",
    attemptNo: 1,
    dailyLimit: 5,
    remainingAttempts: 4,
    roll: 1,
    rarity: null,
    encounterTableSlug: null,
    replayed: false,
    ...overrides,
  };
}

describe("Fishing rarity table", () => {
  it.each([
    [1, null],
    [9, null],
    [10, "COMMON"],
    [14, "COMMON"],
    [15, "UNCOMMON"],
    [17, "UNCOMMON"],
    [18, "RARE"],
    [19, "RARE"],
    [20, "EXTREMELY_RARE"],
  ] as const)("maps D20 %i to %s", (roll, expected) => {
    expect(fishingRarityForRoll(roll)).toBe(expected);
  });
});

describe("FishingService", () => {
  it("consumes a daily attempt even when D20 produces no encounter", async () => {
    const reserveAttempt = vi.fn(async () =>
      reservation({ roll: 9, attemptNo: 4, remainingAttempts: 1 }),
    );
    const createOrReplay = vi.fn();
    const service = new FishingService({ reserveAttempt }, { createOrReplay }, rng(9));

    const result = await service.attempt({
      playerId: PLAYER_ID,
      idempotencyKey: "fish-no-encounter",
    });

    expect(reserveAttempt).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      idempotencyKey: "fish-no-encounter",
      roll: 9,
    });
    expect(createOrReplay).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      roll: 9,
      rarity: null,
      attemptNo: 4,
      dailyLimit: 5,
      remainingAttempts: 1,
      encounter: null,
    });
  });

  it("creates a canonical encounter from the rarity-specific configured table", async () => {
    const reserveAttempt = vi.fn(async () =>
      reservation({
        roll: 16,
        rarity: "UNCOMMON",
        encounterTableSlug: "fishing-uncommon",
      }),
    );
    const createOrReplay = vi.fn(async () => ok(encounterView()));
    const service = new FishingService({ reserveAttempt }, { createOrReplay }, rng(16));

    const result = await service.attempt({ playerId: PLAYER_ID, idempotencyKey: "fish-uncommon" });

    expect(createOrReplay).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      idempotencyKey: `fishing:${ATTEMPT_ID}`,
      encounterTableSlug: "fishing-uncommon",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rarity).toBe("UNCOMMON");
    expect(result.value.encounter?.encounterId).toBe(ENCOUNTER_ID);
  });

  it("uses the persisted reservation on replay instead of changing the effective roll", async () => {
    const reserveAttempt = vi.fn(async () =>
      reservation({
        roll: 16,
        rarity: "UNCOMMON",
        encounterTableSlug: "fishing-uncommon",
        replayed: true,
      }),
    );
    const createOrReplay = vi.fn(async () => ok(encounterView()));
    const service = new FishingService({ reserveAttempt }, { createOrReplay }, rng(20));

    const result = await service.attempt({ playerId: PLAYER_ID, idempotencyKey: "fish-replay" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roll).toBe(16);
    expect(result.value.rarity).toBe("UNCOMMON");
    expect(createOrReplay).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      idempotencyKey: `fishing:${ATTEMPT_ID}`,
      encounterTableSlug: "fishing-uncommon",
    });
  });

  it("rejects a sixth attempt without creating an encounter", async () => {
    const limitReached: FishingDailyLimitReached = {
      kind: "DAILY_LIMIT_REACHED",
      playerId: PLAYER_ID,
      dailyLimit: 5,
      remainingAttempts: 0,
    };
    const reserveAttempt = vi.fn(async () => limitReached);
    const createOrReplay = vi.fn();
    const service = new FishingService({ reserveAttempt }, { createOrReplay }, rng(20));

    const result = await service.attempt({ playerId: PLAYER_ID, idempotencyKey: "fish-sixth" });

    expect(createOrReplay).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_INVALID",
        details: { dailyLimit: 5, remainingAttempts: 0 },
      },
    });
  });

  it("returns a stable action error when fishing is unavailable instead of throwing", async () => {
    const reserveAttempt = vi.fn(async () =>
      ({
        kind: "FISHING_UNAVAILABLE",
        playerId: PLAYER_ID,
        reason: "Fishing is not configured for the current area",
      }) as never,
    );
    const createOrReplay = vi.fn();
    const service = new FishingService({ reserveAttempt }, { createOrReplay }, rng(16));

    const result = await service.attempt({
      playerId: PLAYER_ID,
      idempotencyKey: "fish-unavailable",
    });

    expect(createOrReplay).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_INVALID",
        message: "Fishing is unavailable here",
        details: {
          reason: "Fishing is not configured for the current area",
        },
      },
    });
  });
});
