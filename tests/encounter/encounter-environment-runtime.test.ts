import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  EncounterRecord,
  EncounterTableRecord,
  WildPokemonSnapshot,
} from "../../src/modules/encounter/contracts.js";
import type {
  EncounterRepository,
  EncounterSeedProvider,
  EncounterTransaction,
} from "../../src/modules/encounter/ports.js";
import { EncounterService } from "../../src/modules/encounter/service.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const OPEN = {
  schemaVersion: 1,
  requiredUnlockKeys: [],
  blockedUnlockKeys: [],
} as const;

function table(slug: string, formId: string, timeOfDay: "DAY" | "NIGHT"): EncounterTableRecord {
  return {
    encounterTableId: randomUUID(),
    slug,
    active: true,
    conditions: {
      ...OPEN,
      timeOfDay,
      surface: "LAND",
    },
    entries: [
      {
        entryId: randomUUID(),
        formId,
        weight: 100,
        minLevel: 4,
        maxLevel: 4,
        active: true,
        conditions: OPEN,
      },
    ],
  };
}

describe("EncounterService environmental selection", () => {
  it("selects the table matching explicit DAY/NIGHT runtime context", async () => {
    const playerId = createPlayerId();
    const areaId = randomUUID();
    const contentReleaseId = randomUUID();
    const rulesetId = randomUUID();
    const dayFormId = randomUUID();
    const nightFormId = randomUUID();

    const makeTransaction = (): EncounterTransaction => {
      let persistedSnapshot: WildPokemonSnapshot | null = null;

      return {
        activeContent: async () => ({
          contentReleaseId,
          rulesetId,
          rulesetConfig: { schemaVersion: 1, capture: {} },
        }),
        rulesetConfig: async () => ({ schemaVersion: 1, capture: {} }),
        playerContext: async () => ({
          playerActive: true,
          onboardingComplete: true,
          areaId,
          activeBattle: false,
          unlockKeys: [],
        }),
        partyMembers: async () => [playerId],
        byCreationKey: async () => null,
        activeForPlayer: async () => null,
        byId: async () => null,
        snapshot: async () => persistedSnapshot,
        battleId: async () => null,
        tables: async () => [
          table("day-land", dayFormId, "DAY"),
          table("night-land", nightFormId, "NIGHT"),
        ],
        wildBuild: async (_releaseId, formId) => ({
          formId,
          speciesId: randomUUID(),
          type1Id: randomUUID(),
          type2Id: null,
          baseStats: {
            hp: 40,
            attack: 40,
            defense: 40,
            spAttack: 40,
            spDefense: 40,
            speed: 40,
          },
          abilityIds: [randomUUID()],
          natureIds: [randomUUID()],
          moves: [
            {
              moveId: randomUUID(),
              learnMethod: "START",
              learnLevel: null,
              maxPp: 35,
            },
          ],
        }),
        insertEncounter: async (input) => {
          persistedSnapshot = input.snapshot;
          const record: EncounterRecord = {
            encounterId: input.encounterId,
            playerId: input.playerId,
            areaId: input.areaId,
            status: "CREATED",
            contentReleaseId: input.contentReleaseId,
            rulesetId: input.rulesetId,
            creationIdempotencyKey: input.creationIdempotencyKey,
            rngCounter: input.rngCounter,
            revision: 0n,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
            expiresAt: input.expiresAt,
            closedAt: null,
          };
          return record;
        },
        transition: async () => {
          throw new Error("unexpected transition");
        },
        createBattle: async () => {
          throw new Error("unexpected battle");
        },
        expireDue: async () => [],
      } as EncounterTransaction;
    };

    const repository: EncounterRepository = {
      transaction: async (work) => work(makeTransaction()),
      read: async (work) => work(makeTransaction()),
    };

    const seedProvider: EncounterSeedProvider = {
      create: () => ({
        seed: new Uint8Array(32).fill(7),
        envelope: {
          ciphertext: new Uint8Array([1]),
          iv: new Uint8Array([2]),
          authTag: new Uint8Array([3]),
          keyVersion: 1,
        },
      }),
    };

    const service = new EncounterService(
      repository,
      seedProvider,
      new ManualClock(new Date("2026-09-17T12:00:00.000Z")),
      { enabled: true, reason: null },
    );

    const night = await service.createOrReplay({
      playerId,
      idempotencyKey: "zhoulia-env-night",
      environment: { timeOfDay: "NIGHT", surface: "LAND" },
    });
    expect(night.ok).toBe(true);
    if (!night.ok) return;
    expect(night.value.snapshot.formId).toBe(nightFormId);

    const day = await service.createOrReplay({
      playerId,
      idempotencyKey: "zhoulia-env-day",
      environment: { timeOfDay: "DAY", surface: "LAND" },
    });
    expect(day.ok).toBe(true);
    if (!day.ok) return;
    expect(day.value.snapshot.formId).toBe(dayFormId);
  });

  it("fails closed when time context is omitted for time-gated tables", async () => {
    const playerId = createPlayerId();
    const areaId = randomUUID();

    const transaction = {
      activeContent: async () => ({
        contentReleaseId: randomUUID(),
        rulesetId: randomUUID(),
        rulesetConfig: { schemaVersion: 1, capture: {} },
      }),
      playerContext: async () => ({
        playerActive: true,
        onboardingComplete: true,
        areaId,
        activeBattle: false,
        unlockKeys: [],
      }),
      partyMembers: async () => [playerId],
      byCreationKey: async () => null,
      activeForPlayer: async () => null,
      tables: async () => [table("night-land", randomUUID(), "NIGHT")],
    } as unknown as EncounterTransaction;

    const repository: EncounterRepository = {
      transaction: async (work) => work(transaction),
      read: async (work) => work(transaction),
    };

    const seedProvider: EncounterSeedProvider = {
      create: () => {
        throw new Error("seed must not be requested when no table is eligible");
      },
    };

    const service = new EncounterService(
      repository,
      seedProvider,
      new ManualClock(new Date("2026-09-17T12:00:00.000Z")),
      { enabled: true, reason: null },
    );

    const result = await service.createOrReplay({
      playerId,
      idempotencyKey: "zhoulia-env-missing",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACTION_INVALID");
  });
});
