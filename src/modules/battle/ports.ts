import type { BattleAction, BattleEvent, BattleState, BattleStatus } from "./contracts.js";
import type { RulesetSnapshot } from "../catalog/contracts.js";

export interface BattleSeedEnvelope {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

export interface BattleRootRecord {
  readonly battleId: string;
  readonly battleType: "WILD" | "NPC" | "PVP";
  readonly status: BattleStatus;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly encounterId: string | null;
  readonly turnNumber: number;
  readonly version: number;
  readonly seed: BattleSeedEnvelope;
  readonly rngCounter: bigint;
  readonly endedAt: Date | null;
}

export interface BattleMoveBuild {
  readonly slotNo: number;
  readonly moveId: string;
  readonly typeId: string;
  readonly typeSlug: string;
  readonly category: "PHYSICAL" | "SPECIAL" | "STATUS";
  readonly power: number | null;
  readonly accuracy: number | null;
  readonly priority: number;
  readonly maxPp: number | null;
  readonly ppCurrent: number | null;
  readonly effectKey: string | null;
  readonly effectConfig: unknown;
  readonly makesContact: boolean;
}

export interface BattlePokemonBuild {
  readonly pokemonInstanceId: string | null;
  readonly participantKind: "PLAYER_POKEMON" | "WILD_POKEMON" | "NPC_POKEMON";
  readonly rosterPosition: number;
  readonly formId: string;
  readonly speciesId: string;
  readonly level: number;
  readonly type1Id: string;
  readonly type1Slug: string;
  readonly type2Id: string | null;
  readonly type2Slug: string | null;
  readonly baseStats: Readonly<{
    hp: number;
    attack: number;
    defense: number;
    spAttack: number;
    spDefense: number;
    speed: number;
  }>;
  readonly ivs: Readonly<{
    hp: number;
    attack: number;
    defense: number;
    spAttack: number;
    spDefense: number;
    speed: number;
  }>;
  readonly nature: Readonly<{
    natureId: string;
    increasedStat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
    decreasedStat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" | null;
  }>;
  readonly ability: Readonly<{
    abilityId: string;
    effectKey: string | null;
    effectConfig: unknown;
  }>;
  readonly moves: readonly BattleMoveBuild[];
  readonly maxHp: number;
  readonly currentHp: number;
  readonly majorStatus: "BURN" | "POISON" | "PARALYSIS" | "SLEEP" | "FREEZE" | null;
}

export interface BattleInitializationData {
  readonly playerId: string;
  readonly playerParty: readonly BattlePokemonBuild[];
  readonly opponentParty: readonly BattlePokemonBuild[];
}

export interface StoredBattleAction {
  readonly actionId: string;
  readonly battleId: string;
  readonly expectedBattleVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly action: BattleAction;
  readonly status: "RECEIVED" | "ACCEPTED" | "REJECTED" | "RESOLVED";
  readonly resolvedBattleVersion: number | null;
}

export interface PersistTurnInput {
  readonly actionId: string;
  readonly battleId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly playerAction: BattleAction;
  readonly nextState: BattleState;
  readonly events: readonly BattleEvent[];
  readonly rngCounter: bigint;
}

export interface PersistTurnSuccess {
  readonly kind: "PERSISTED";
  readonly state: BattleState;
}

export interface PersistTurnConflict {
  readonly kind: "VERSION_CONFLICT";
  readonly currentState: BattleState;
}

export type PersistTurnResult = PersistTurnSuccess | PersistTurnConflict;

export interface BattleTransaction {
  loadRoot(battleId: string, lock?: boolean): Promise<BattleRootRecord | null>;
  loadRuleset(rulesetId: string): Promise<RulesetSnapshot | null>;
  loadState(battleId: string, version?: number): Promise<BattleState | null>;
  loadInitializationData(root: BattleRootRecord): Promise<BattleInitializationData | null>;
  initialize(root: BattleRootRecord, state: BattleState): Promise<BattleState>;
  findAction(idempotencyKey: string, lock?: boolean): Promise<StoredBattleAction | null>;
  rejectAction(input: {
    readonly actionId: string;
    readonly battleId: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly action: BattleAction;
  }): Promise<void>;
  persistTurn(input: PersistTurnInput): Promise<PersistTurnResult>;
}

export interface BattleRepository {
  transaction<T>(work: (transaction: BattleTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: BattleTransaction) => Promise<T>): Promise<T>;
}

export interface BattleSeedReader {
  decrypt(root: BattleRootRecord): Uint8Array;
}
