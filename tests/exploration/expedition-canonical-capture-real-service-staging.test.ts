import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ExpeditionCanonicalChoiceStagingResolver } from "../../src/modules/exploration/expedition-canonical-choice-staging.js";
import type { CaptureAttemptRecord, CaptureContext } from "../../src/modules/capture/contracts.js";
import type {
  CapturePendingWrite,
  CaptureRepository,
  CaptureTransaction,
  CaptureSeedProvider,
} from "../../src/modules/capture/ports.js";
import { CaptureService } from "../../src/modules/capture/service.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import {
  createPlayerId,
  createEncounterId,
  createCorrelationId,
} from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const encounterId = createEncounterId();
const outcomeId = randomUUID();
const itemId = randomUUID();
const privateJid = "5579999999999@s.whatsapp.net";
const providerQuote = randomUUID().replaceAll("-", "").toUpperCase();

function canonicalContext(): CaptureContext {
  return {
    playerId,
    playerActive: true,
    onboardingComplete: true,
    encounterId,
    encounterRevision: 2n,
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
        allowedEncounterStates: ["ENGAGED", "IN_BATTLE"],
      },
      defeat: { automaticMoneyLoss: false },
      narrative: { authority: "N0_FLAVOR_ONLY" },
    },
    catchRate: 255,
    encounterSnapshot: {
      schemaVersion: 1,
      formId: randomUUID(),
      speciesId: randomUUID(),
      level: 3,
      type1Id: randomUUID(),
      type2Id: null,
      baseStats: { hp: 40, attack: 45, defense: 40, spAttack: 35, spDefense: 35, speed: 56 },
      ivs: { hp: 1, attack: 2, defense: 3, spAttack: 4, spDefense: 5, speed: 6 },
      natureId: randomUUID(),
      abilityId: randomUUID(),
      moves: [{ moveId: randomUUID(), ppCurrent: 35 }],
      maxHp: 18,
      currentHp: 1,
      shiny: false,
      gender: null,
    },
    battleId: null,
    battleState: null,
    ball: {
      itemId,
      itemKind: "BALL",
      effectKey: "catch-modifier",
      effectConfig: { multiplierBasisPoints: 10_000 },
    },
    explicitModifierBasisPoints: [],
  };
}

function incoming(): MessageHandlerContext {
  return {
    inboxMessageId: randomUUID(),
    correlationId: createCorrelationId(),
    causationId: randomUUID(),
    idempotencyKey: "inbox:baileys:canonical-real-capture",
    message: {
      provider: "baileys",
      externalMessageId: "canonical-real-capture",
      senderRef: privateJid,
      chatRef: privateJid,
      occurredAt: "2026-11-02T00:30:00.000Z",
      text: "2",
      replyToExternalMessageId: providerQuote,
      mediaRefs: [],
    },
  };
}

function setup() {
  const source = canonicalContext();
  let balance = 1;
  let pending: CapturePendingWrite | null = null;
  let stored: CaptureAttemptRecord | null = null;
  const consumeBall = vi.fn(async () => {
    if (balance <= 0) return "INSUFFICIENT" as const;
    balance--;
    return "CONSUMED" as const;
  });
  const transactions = {
    findAttempt: async () => stored,
    loadContext: async (_playerId: string, _encounterId: string, requestedBallItemId: string) =>
      requestedBallItemId === itemId ? source : null,
    beginResolving: async () => 3n,
    insertPending: async (entry: CapturePendingWrite) => {
      pending = entry;
      return true;
    },
    consumeBall,
    nextRosterPlacement: async () => ({
      placementKind: "TEAM" as const,
      boxNo: null,
      slotNo: 1,
    }),
    resolveFailure: async () => {
      throw new Error("Expected deterministic successful capture with zero seed");
    },
    resolveSuccess: async (resolved: {
      pokemonInstanceId: CaptureAttemptRecord["pokemonInstanceId"];
      placement: CaptureAttemptRecord["placement"];
    }) => {
      const data = pending;
      if (data === null) throw new Error("No capture pending record");
      stored = {
        id: data.attemptId,
        playerId,
        encounterId,
        battleId: null,
        ballItemId: itemId,
        idempotencyKey: data.idempotencyStorageKey,
        requestFingerprint: data.requestFingerprint,
        sourceEncounterStatus: "ENGAGED",
        correlationId: data.correlationId,
        status: "CAPTURED",
        probabilityBasisPoints: data.probabilityBasisPoints,
        rollBasisPoints: data.rollBasisPoints,
        pokemonInstanceId: resolved.pokemonInstanceId,
        placement: resolved.placement,
        breakdown: data.breakdown,
        resolvedAt: new Date(),
      };
    },
  } satisfies CaptureTransaction;
  const repository = {
    transaction: <T>(work: (tx: CaptureTransaction) => Promise<T>) => work(transactions),
  } satisfies CaptureRepository;
  const seedProvider = {
    create: vi.fn(() => ({
      seed: Buffer.alloc(32),
      envelope: {
        ciphertext: Buffer.alloc(1),
        iv: Buffer.alloc(1),
        authTag: Buffer.alloc(1),
        keyVersion: 1,
      },
    })),
  } satisfies CaptureSeedProvider;
  const capture = new CaptureService(repository, seedProvider);

  let actionable = false;
  let chosenBallId: string = itemId;
  const resolver = new ExpeditionCanonicalChoiceStagingResolver(
    {
      resolvePlayer: async () => ok({ playerId, state: "COMPLETE" as const, created: false }),
    } as unknown as ConstructorParameters<typeof ExpeditionCanonicalChoiceStagingResolver>[0],
    {
      resolve: async () => ok({ playerId, outcomeId, encounterId, encounterRevision: 2n }),
    } as unknown as ConstructorParameters<typeof ExpeditionCanonicalChoiceStagingResolver>[1],
    {
      activeForPlayer: async () =>
        ok({ playerId, encounterId, revision: 2n, status: "ENGAGED", battleId: null }),
    } as unknown as ConstructorParameters<typeof ExpeditionCanonicalChoiceStagingResolver>[2],
    {
      resolve: async () =>
        ok({
          menuId: randomUUID(),
          playerId,
          outcomeId,
          encounterId,
          encounterRevision: 2n,
          ballItemIds: { "2": chosenBallId },
          ...(actionable ? { actionable: true, captureEnabled: true, battleEnabled: false } : {}),
        }),
    } as unknown as ConstructorParameters<typeof ExpeditionCanonicalChoiceStagingResolver>[3],
    capture,
    {
      startCanonical: async (): Promise<never> => {
        throw new Error("Capture must not start PvE");
      },
    } as unknown as ConstructorParameters<typeof ExpeditionCanonicalChoiceStagingResolver>[5],
  );
  return {
    resolver,
    consumeBall,
    seedProvider,
    setActionable: (next: boolean) => {
      actionable = next;
    },
    setBall: (next: string) => {
      chosenBallId = next;
    },
    remaining: () => balance,
  };
}

describe("real CaptureService from a gated issued-menu reply", () => {
  it("never consumes an item in READ_ONLY mode; ACTIONABLE commits once, then canonical replay", async () => {
    const f = setup();
    const context = incoming();
    expect(await f.resolver.resolve(context)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(f.consumeBall).not.toHaveBeenCalled();
    expect(f.seedProvider.create).not.toHaveBeenCalled();

    f.setActionable(true);
    const first = await f.resolver.resolve(context);
    expect(first).toMatchObject({ ok: true, value: { resultRefType: "ENCOUNTER" } });
    expect(f.remaining()).toBe(0);
    expect(f.consumeBall).toHaveBeenCalledTimes(1);
    expect(f.seedProvider.create).toHaveBeenCalledTimes(1);

    const replay = await f.resolver.resolve({ ...context, correlationId: createCorrelationId() });
    expect(replay).toEqual(first);
    expect(f.remaining()).toBe(0);
    expect(f.consumeBall).toHaveBeenCalledTimes(1);
    expect(f.seedProvider.create).toHaveBeenCalledTimes(1);
  });

  it("does not run capture RNG or consume inventory for a Ball ID not in the pinned encounter", async () => {
    const f = setup();
    f.setActionable(true);
    f.setBall(randomUUID());
    const answer = await f.resolver.resolve(incoming());
    expect(answer).toMatchObject({ ok: false });
    expect(f.remaining()).toBe(1);
    expect(f.consumeBall).not.toHaveBeenCalled();
    expect(f.seedProvider.create).not.toHaveBeenCalled();
  });
});
