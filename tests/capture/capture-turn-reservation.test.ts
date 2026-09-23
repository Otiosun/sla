import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BattleState } from "../../src/modules/battle/contracts.js";
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

function battleContext() {
  const playerId = createPlayerId();
  const encounterId = createEncounterId();
  const battleId = randomUUID();
  const actorParticipantId = randomUUID();
  const targetParticipantId = randomUUID();
  const ballItemId = randomUUID();
  const formId = randomUUID();
  const speciesId = randomUUID();
  const typeId = randomUUID();
  const moveId = randomUUID();
  const state = {
    battleId,
    battleType: "WILD",
    status: "ACTIVE",
    encounterId,
    version: 4,
    turnNumber: 2,
    sides: [
      {
        sideNo: 1,
        controllerKind: "PLAYER",
        playerId,
        participantIds: [actorParticipantId],
        activeParticipantId: actorParticipantId,
        result: null,
      },
      {
        sideNo: 2,
        controllerKind: "WILD",
        playerId: null,
        participantIds: [targetParticipantId],
        activeParticipantId: targetParticipantId,
        result: null,
      },
    ],
    combatants: [
      {
        participantId: actorParticipantId,
        participantKind: "PLAYER_POKEMON",
        sideNo: 1,
        currentHp: 20,
      },
      {
        participantId: targetParticipantId,
        participantKind: "WILD_POKEMON",
        sideNo: 2,
        rosterPosition: 1,
        currentHp: 10,
        majorStatus: null,
        moves: [{ moveId, ppCurrent: 20 }],
      },
    ],
  } as unknown as BattleState;

  const context = {
    playerId,
    playerActive: true,
    onboardingComplete: true,
    encounterId,
    encounterRevision: 7n,
    sourceStatus: "IN_BATTLE",
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
    catchRate: 120,
    encounterSnapshot: {
      schemaVersion: 1,
      formId,
      speciesId,
      level: 5,
      type1Id: typeId,
      type2Id: null,
      baseStats: { hp: 40, attack: 40, defense: 40, spAttack: 40, spDefense: 40, speed: 40 },
      ivs: { hp: 1, attack: 1, defense: 1, spAttack: 1, spDefense: 1, speed: 1 },
      natureId: randomUUID(),
      abilityId: randomUUID(),
      moves: [{ moveId, ppCurrent: 20 }],
      maxHp: 20,
      currentHp: 10,
      shiny: false,
      gender: null,
    },
    targetWildNo: 1,
    battleId,
    battleState: state,
    ball: {
      itemId: ballItemId,
      itemKind: "BALL",
      effectKey: "catch-modifier",
      effectConfig: { multiplierBasisPoints: 10_000 },
    },
    explicitModifierBasisPoints: [],
  } satisfies CaptureContext;

  return { context, playerId, encounterId, battleId, actorParticipantId, targetParticipantId };
}

describe("capture PVE turn reservation", () => {
  it("rejects an already-used controller turn before RNG or Ball mutation", async () => {
    const setup = battleContext();
    const consumeBall = vi.fn(async () => "CONSUMED" as const);
    const claimBattleTurn = vi.fn(async () => ({
      kind: "REJECTED" as const,
      code: "TURN_WINDOW_ALREADY_SUBMITTED",
      message: "already submitted",
    }));
    const transaction = {
      findAttempt: async () => null,
      loadContext: async () => setup.context,
      claimBattleTurn,
      beginResolving: async () => {
        throw new Error("beginResolving must not run after rejected reservation");
      },
      insertPending: async () => {
        throw new Error("insertPending must not run after rejected reservation");
      },
      consumeBall,
      nextRosterPlacement: async () => {
        throw new Error("nextRosterPlacement must not run after rejected reservation");
      },
      resolveFailure: async () => {
        throw new Error("resolveFailure must not run after rejected reservation");
      },
      resolveSuccess: async () => {
        throw new Error("resolveSuccess must not run after rejected reservation");
      },
    } satisfies CaptureTransaction;
    const repository = {
      transaction: (work) => work(transaction),
    } satisfies CaptureRepository;
    const seedProvider = {
      create: vi.fn(() => {
        throw new Error("RNG must not run after rejected reservation");
      }),
    } satisfies CaptureSeedProvider;

    const result = await new CaptureService(repository, seedProvider).attempt({
      playerId: setup.playerId,
      encounterId: setup.encounterId,
      expectedEncounterRevision: setup.context.encounterRevision,
      expectedBattleVersion: 4,
      actorParticipantId: setup.actorParticipantId,
      targetWildNo: 1,
      ballItemId: setup.context.ball.itemId,
      idempotencyKey: "capture-turn-already-used",
      correlationId: createCorrelationId(),
      causationId: null,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_INVALID",
        details: { turnWindowCode: "TURN_WINDOW_ALREADY_SUBMITTED" },
      },
    });
    expect(claimBattleTurn).toHaveBeenCalledWith({
      battleId: setup.battleId,
      expectedBattleVersion: 4,
      playerId: setup.playerId,
      actorParticipantId: setup.actorParticipantId,
      targetParticipantId: setup.targetParticipantId,
      ballItemId: setup.context.ball.itemId,
      idempotencyKey: "capture-turn-already-used",
    });
    expect(seedProvider.create).not.toHaveBeenCalled();
    expect(consumeBall).not.toHaveBeenCalled();
  });
});
