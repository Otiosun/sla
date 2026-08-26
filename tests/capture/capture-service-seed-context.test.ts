import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CaptureContext } from "../../src/modules/capture/contracts.js";
import type {
  CaptureRepository,
  CaptureSeedProvider,
  CaptureTransaction,
} from "../../src/modules/capture/ports.js";
import { CaptureService } from "../../src/modules/capture/service.js";
import {
  createCorrelationId,
  createEncounterId,
  createPlayerId,
} from "../../src/shared-kernel/ids.js";

function context(): CaptureContext {
  const playerId = createPlayerId();
  const encounterId = createEncounterId();
  const formId = randomUUID();
  const speciesId = randomUUID();
  const typeId = randomUUID();
  const natureId = randomUUID();
  const abilityId = randomUUID();
  const moveId = randomUUID();
  return {
    playerId,
    playerActive: true,
    onboardingComplete: true,
    encounterId,
    encounterRevision: 7n,
    sourceStatus: "ENGAGED",
    contentReleaseId: randomUUID(),
    rulesetId: randomUUID(),
    rulesetConfig: {
      schemaVersion: 1,
      battle: {
        statModel: "SIX_STATS",
        physicalSpecialByMove: true,
        ivEnabled: true,
        evEnabled: false,
        natureEnabled: true,
        maxMoves: 4,
        ppEnabled: true,
        criticalMultiplierBasisPoints: 15_000,
        accuracyEvasionEnabled: true,
      },
      capture: {
        model: "POKEMON_INSPIRED_V1",
        maxProbabilityBasisPoints: 9_500,
      },
      defeat: { automaticMoneyLoss: false },
      narrative: { authority: "N0_FLAVOR_ONLY" },
    },
    catchRate: 255,
    encounterSnapshot: {
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
      currentHp: 18,
      shiny: false,
      gender: null,
    },
    battleId: null,
    battleState: null,
    ball: {
      itemId: randomUUID(),
      itemKind: "BALL",
      effectKey: "catch-modifier",
      effectConfig: { multiplierBasisPoints: 10_000 },
    },
    explicitModifierBasisPoints: [],
  };
}

function repository(value: CaptureContext): CaptureRepository {
  const transaction = {
    findAttempt: async () => null,
    loadContext: async () => value,
    beginResolving: async () => {
      throw new Error("beginResolving must not run after seed probe aborts");
    },
    insertPending: async () => {
      throw new Error("insertPending must not run after seed probe aborts");
    },
    consumeBall: async () => {
      throw new Error("consumeBall must not run after seed probe aborts");
    },
    nextRosterPlacement: async () => {
      throw new Error("nextRosterPlacement must not run after seed probe aborts");
    },
    resolveFailure: async () => {
      throw new Error("resolveFailure must not run after seed probe aborts");
    },
    resolveSuccess: async () => {
      throw new Error("resolveSuccess must not run after seed probe aborts");
    },
  } satisfies CaptureTransaction;
  return {
    transaction: (work) => work(transaction),
  };
}

describe("CaptureService RNG context", () => {
  it("uses stable semantic idempotency identity instead of random attempt UUID", async () => {
    const value = context();
    const contexts: string[] = [];
    const seedProvider = {
      create(seedContext: string): never {
        contexts.push(seedContext);
        throw new Error("seed context probe");
      },
    } satisfies CaptureSeedProvider;
    const service = new CaptureService(repository(value), seedProvider);
    const base = {
      playerId: value.playerId,
      encounterId: value.encounterId,
      expectedEncounterRevision: value.encounterRevision,
      expectedBattleVersion: null,
      ballItemId: value.ball.itemId,
      idempotencyKey: "same-message",
      correlationId: createCorrelationId(),
      causationId: null,
    } as const;

    await service.attempt(base);
    await service.attempt({ ...base, correlationId: createCorrelationId() });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0]).not.toContain("capture:");
  });

  it("changes context when the semantic idempotency identity changes", async () => {
    const value = context();
    const contexts: string[] = [];
    const seedProvider = {
      create(seedContext: string): never {
        contexts.push(seedContext);
        throw new Error("seed context probe");
      },
    } satisfies CaptureSeedProvider;
    const service = new CaptureService(repository(value), seedProvider);
    const base = {
      playerId: value.playerId,
      encounterId: value.encounterId,
      expectedEncounterRevision: value.encounterRevision,
      expectedBattleVersion: null,
      ballItemId: value.ball.itemId,
      correlationId: createCorrelationId(),
      causationId: null,
    } as const;

    await service.attempt({ ...base, idempotencyKey: "semantic-message-a" });
    await service.attempt({ ...base, idempotencyKey: "semantic-message-b" });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
  });
});
