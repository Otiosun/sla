import { describe, expect, it } from "vitest";
import type { RulesetSnapshot } from "../../src/modules/catalog/contracts.js";
import type { BattleAction, BattleState } from "../../src/modules/battle/contracts.js";
import type { BattleRootRecord, BattleSeedReader } from "../../src/modules/battle/ports.js";
import {
  createTurnWindow,
  submitTurnAction,
  type TurnWindowAggregate,
} from "../../src/modules/battle/turn-window.js";
import {
  PvpTurnResolutionService,
  type PersistPvpTurnResolutionInput,
  type PvpTurnResolutionRepository,
  type PvpTurnResolutionTransaction,
} from "../../src/modules/battle/pvp-turn-resolution.js";
import { IDS, battleState, playerCombatant, wildCombatant } from "./fixtures.js";

const PLAYER_TWO = "00000000-0000-4000-8000-000000000006";
const PLAYER_TWO_INSTANCE = "00000000-0000-4000-8000-000000000303";
const WINDOW_ID = "00000000-0000-4000-8000-000000000901";
const SUBMISSION_ONE = "00000000-0000-4000-8000-000000000902";
const SUBMISSION_TWO = "00000000-0000-4000-8000-000000000903";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000904";
const OPENED_AT = new Date("2026-08-31T10:00:00.000Z");
const DEADLINE_AT = new Date("2026-08-31T10:05:00.000Z");
const COMMITTED_AT = new Date("2026-08-31T10:01:00.000Z");

function pvpState(): BattleState {
  const base = battleState();
  const first = playerCombatant();
  const secondBase = wildCombatant();
  const second = {
    ...secondBase,
    participantKind: "PLAYER_POKEMON" as const,
    pokemonInstanceId: PLAYER_TWO_INSTANCE,
    level: first.level,
    baseStats: { ...first.baseStats },
    ivs: { ...first.ivs },
    nature: { ...first.nature },
  };
  return {
    ...base,
    battleType: "PVP",
    encounterId: null,
    sides: [
      { ...base.sides[0], playerId: IDS.player },
      {
        ...base.sides[1],
        controllerKind: "PLAYER",
        playerId: PLAYER_TWO,
        participantIds: [second.participantId],
        activeParticipantId: second.participantId,
      },
    ],
    combatants: [first, second],
  };
}

function root(state = pvpState()): BattleRootRecord {
  return {
    battleId: state.battleId,
    battleType: "PVP",
    status: "ACTIVE",
    contentReleaseId: state.contentReleaseId,
    rulesetId: state.rulesetId,
    encounterId: null,
    turnNumber: state.turnNumber,
    version: state.version,
    seed: {
      ciphertext: new Uint8Array([1]),
      iv: new Uint8Array([2]),
      authTag: new Uint8Array([3]),
      keyVersion: 1,
    },
    rngCounter: BigInt(state.rngCounter),
    endedAt: null,
  };
}

function ruleset(): RulesetSnapshot {
  return {
    id: IDS.ruleset,
    status: "PUBLISHED",
    config: {
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
        stabMultiplierBasisPoints: 15_000,
        damageRandomMinBasisPoints: 10_000,
        damageRandomMaxBasisPoints: 10_000,
        switchConsumesTurn: true,
      },
      capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 10_000 },
      defeat: { automaticMoneyLoss: false },
      narrative: { authority: "N0_FLAVOR_ONLY" },
    },
    typeMatchups: [],
  };
}

function actionOne(state = pvpState()): BattleAction {
  return {
    type: "USE_MOVE",
    actorParticipantId: state.sides[0].activeParticipantId,
    moveSlot: 1,
    targetParticipantId: state.sides[1].activeParticipantId,
  };
}

function actionTwo(state = pvpState()): BattleAction {
  return {
    type: "USE_MOVE",
    actorParticipantId: state.sides[1].activeParticipantId,
    moveSlot: 1,
    targetParticipantId: state.sides[0].activeParticipantId,
  };
}

function collectingWindow(): TurnWindowAggregate {
  const created = createTurnWindow({
    id: WINDOW_ID,
    battleId: IDS.battle,
    battleVersion: 0,
    turnNumber: 0,
    openedAt: OPENED_AT,
    deadlineAt: DEADLINE_AT,
    requiredPlayers: [
      { playerId: IDS.player, sideNo: 1 },
      { playerId: PLAYER_TWO, sideNo: 2 },
    ],
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function lockedWindow(order: readonly [1 | 2, 1 | 2] = [1, 2]): TurnWindowAggregate {
  let aggregate = collectingWindow();
  const state = pvpState();
  for (const sideNo of order) {
    const submitted = submitTurnAction(aggregate, {
      id: sideNo === 1 ? SUBMISSION_ONE : SUBMISSION_TWO,
      playerId: sideNo === 1 ? IDS.player : PLAYER_TWO,
      sideNo,
      expectedBattleVersion: 0,
      idempotencyKey: `submission-${sideNo}`,
      action: sideNo === 1 ? actionOne(state) : actionTwo(state),
      submittedAt: new Date(OPENED_AT.getTime() + sideNo * 1_000),
    });
    if (!submitted.ok) throw new Error(submitted.error.message);
    aggregate = submitted.value.aggregate;
  }
  expect(aggregate.window.status).toBe("LOCKED");
  return aggregate;
}

class FakeTransaction implements PvpTurnResolutionTransaction {
  public persistCalls: PersistPvpTurnResolutionInput[] = [];
  public calls: string[] = [];
  public persistedState: BattleState | null = null;
  public conflict = false;

  public constructor(
    public aggregate: TurnWindowAggregate,
    public battleRoot: BattleRootRecord = root(),
    public state: BattleState = pvpState(),
  ) {}

  public async loadTurnWindow(
    turnWindowId: string,
    lock = false,
  ): Promise<TurnWindowAggregate | null> {
    this.calls.push(`window:${lock ? "lock" : "read"}`);
    return turnWindowId === this.aggregate.window.id ? structuredClone(this.aggregate) : null;
  }

  public async loadBattleRoot(battleId: string, lock = false): Promise<BattleRootRecord | null> {
    this.calls.push(`battle:${lock ? "lock" : "read"}`);
    return battleId === this.battleRoot.battleId ? this.battleRoot : null;
  }

  public async loadRuleset(rulesetId: string): Promise<RulesetSnapshot | null> {
    this.calls.push("ruleset");
    return rulesetId === IDS.ruleset ? ruleset() : null;
  }

  public async loadBattleState(battleId: string, version: number): Promise<BattleState | null> {
    this.calls.push(`state:${version}`);
    if (battleId !== this.state.battleId) return null;
    if (this.persistedState !== null && this.persistedState.version === version) {
      return structuredClone(this.persistedState);
    }
    return this.state.version === version ? structuredClone(this.state) : null;
  }

  public async persistResolution(input: PersistPvpTurnResolutionInput) {
    this.persistCalls.push(structuredClone(input));
    if (this.conflict) {
      return { kind: "VERSION_CONFLICT" as const, currentState: structuredClone(this.state) };
    }
    this.aggregate = structuredClone(input.committedWindow);
    this.persistedState = structuredClone(input.nextState);
    return { kind: "PERSISTED" as const, state: structuredClone(input.nextState) };
  }
}

class FakeRepository implements PvpTurnResolutionRepository {
  public constructor(public readonly transactionState: FakeTransaction) {}

  public async transaction<T>(work: (transaction: PvpTurnResolutionTransaction) => Promise<T>) {
    return work(this.transactionState);
  }
}

function seedReader(onDecrypt?: () => void): BattleSeedReader {
  return {
    decrypt: () => {
      onDecrypt?.();
      return new Uint8Array(32).fill(7);
    },
  };
}

function service(transaction: FakeTransaction, onDecrypt?: () => void) {
  return new PvpTurnResolutionService(
    new FakeRepository(transaction),
    seedReader(onDecrypt),
    () => CORRELATION_ID,
    () => COMMITTED_AT,
  );
}

describe("PVP turn resolution", () => {
  it("rejects a turn window that is not locked without touching battle persistence", async () => {
    const transaction = new FakeTransaction(collectingWindow());
    const result = await service(transaction).resolve(WINDOW_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("TURN_WINDOW_NOT_LOCKED");
    expect(transaction.persistCalls).toHaveLength(0);
    expect(transaction.calls).toEqual(["window:read", "battle:lock", "window:lock"]);
  });

  it("canonicalizes human actions by side number before deterministic resolution", async () => {
    const first = new FakeTransaction(lockedWindow([1, 2]));
    const second = new FakeTransaction(lockedWindow([2, 1]));

    const resolvedFirst = await service(first).resolve(WINDOW_ID);
    const resolvedSecond = await service(second).resolve(WINDOW_ID);

    expect(resolvedFirst.ok).toBe(true);
    expect(resolvedSecond.ok).toBe(true);
    if (!resolvedFirst.ok || !resolvedSecond.ok) throw new Error("expected resolution success");
    expect(resolvedFirst.value.state).toEqual(resolvedSecond.value.state);
    expect(resolvedFirst.value.events).toEqual(resolvedSecond.value.events);
    expect(first.persistCalls[0]?.committedWindow.window.status).toBe("COMMITTED");
    expect(
      first.persistCalls[0]?.committedWindow.submissions.every(
        (entry) => entry.status !== "ACTIVE",
      ),
    ).toBe(true);
  });

  it("replays a committed window from its produced snapshot without decrypting or resolving again", async () => {
    const transaction = new FakeTransaction(lockedWindow());
    const first = await service(transaction).resolve(WINDOW_ID);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first resolution success");

    let decryptions = 0;
    const replay = await service(transaction, () => {
      decryptions += 1;
    }).resolve(WINDOW_ID);

    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected replay success");
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.events).toEqual([]);
    expect(replay.value.state).toEqual(first.value.state);
    expect(transaction.persistCalls).toHaveLength(1);
    expect(decryptions).toBe(0);
  });

  it("surfaces a battle CAS conflict instead of committing the turn window", async () => {
    const transaction = new FakeTransaction(lockedWindow());
    transaction.conflict = true;

    const result = await service(transaction).resolve(WINDOW_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected version conflict");
    expect(result.error.code).toBe("BATTLE_VERSION_CONFLICT");
    expect(transaction.aggregate.window.status).toBe("LOCKED");
    expect(transaction.persistCalls).toHaveLength(1);
  });
});
