import {
  type BattleCombatant,
  type BattleSide,
  type BattleState,
  BattleStateSchema,
  type ControllerKind,
  EMPTY_BATTLE_STAGES,
  type ParticipantKind,
} from "./contracts.js";
import type { BattlePokemonBuild, BattleRootRecord } from "./ports.js";

export interface BattleInitializationError {
  readonly code: "BATTLE_INITIALIZATION_INVALID";
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type BattleInitializationResult =
  | { readonly ok: true; readonly value: BattleState }
  | { readonly ok: false; readonly error: BattleInitializationError };

export interface BattleInitializationSide {
  readonly sideNo: number;
  readonly controllerKind: ControllerKind;
  readonly playerId: string | null;
  readonly party: readonly BattlePokemonBuild[];
  readonly playerParties?: readonly {
    readonly playerId: string;
    readonly party: readonly BattlePokemonBuild[];
  }[];
}

export interface InitializeBattleStateInput {
  readonly root: BattleRootRecord;
  readonly sides: readonly BattleInitializationSide[];
  readonly idFactory: () => string;
}

function failure(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): BattleInitializationResult {
  return {
    ok: false,
    error: {
      code: "BATTLE_INITIALIZATION_INVALID",
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function expectedParticipantKind(controllerKind: ControllerKind): ParticipantKind | null {
  if (controllerKind === "PLAYER") return "PLAYER_POKEMON";
  if (controllerKind === "WILD") return "WILD_POKEMON";
  if (controllerKind === "NPC") return "NPC_POKEMON";
  return null;
}

function buildCombatant(
  build: BattlePokemonBuild,
  participantId: string,
  sideNo: number,
): BattleCombatant {
  return {
    participantId,
    sideNo,
    rosterPosition: build.rosterPosition,
    participantKind: build.participantKind,
    pokemonInstanceId: build.pokemonInstanceId,
    formId: build.formId,
    speciesId: build.speciesId,
    level: build.level,
    type1Id: build.type1Id,
    type1Slug: build.type1Slug,
    type2Id: build.type2Id,
    type2Slug: build.type2Slug,
    baseStats: { ...build.baseStats },
    ivs: { ...build.ivs },
    nature: { ...build.nature },
    ability: { ...build.ability },
    moves: build.moves.map((move) => ({
      slotNo: move.slotNo,
      moveId: move.moveId,
      typeId: move.typeId,
      typeSlug: move.typeSlug,
      category: move.category,
      power: move.power,
      accuracy: move.accuracy,
      priority: move.priority,
      maxPp: move.maxPp,
      ppCurrent: move.ppCurrent,
      effectKey: move.effectKey,
      effectConfig: structuredClone(move.effectConfig),
      flags: { makesContact: move.makesContact },
    })),
    maxHp: build.maxHp,
    currentHp: Math.max(0, Math.min(build.currentHp, build.maxHp)),
    majorStatus:
      build.majorStatus === null
        ? null
        : { key: build.majorStatus, counter: build.majorStatus === "BAD_POISON" ? 1 : null },
    stages: { ...EMPTY_BATTLE_STAGES },
    volatile: { flinch: false, confusionTurns: 0 },
  };
}

function controllersMatchBattleType(
  battleType: BattleRootRecord["battleType"],
  sides: readonly BattleInitializationSide[],
): boolean {
  const playerSides = sides.filter((side) => side.controllerKind === "PLAYER").length;
  if (battleType === "PVP") return playerSides === sides.length;
  if (sides.length !== 2 || sides[0]?.controllerKind !== "PLAYER") return false;
  return battleType === "WILD"
    ? sides[1]?.controllerKind === "WILD"
    : sides[1]?.controllerKind === "NPC";
}

export function initializeBattleState(
  input: InitializeBattleStateInput,
): BattleInitializationResult {
  if (input.root.status !== "CREATED" || input.root.version !== 0 || input.root.turnNumber !== 0) {
    return failure("Battle version-zero initialization requires a pristine CREATED root", {
      status: input.root.status,
      version: input.root.version,
      turnNumber: input.root.turnNumber,
    });
  }
  if (input.sides.length < 2) {
    return failure("Battle initialization requires at least two sides");
  }
  if (!controllersMatchBattleType(input.root.battleType, input.sides)) {
    return failure("Battle controllers do not match the battle type");
  }

  const sideNumbers = new Set<number>();
  const sides: BattleSide[] = [];
  const combatants: BattleCombatant[] = [];

  for (const side of input.sides) {
    if (!Number.isSafeInteger(side.sideNo) || side.sideNo <= 0 || sideNumbers.has(side.sideNo)) {
      return failure("Battle side numbers must be unique positive safe integers", {
        sideNo: side.sideNo,
      });
    }
    sideNumbers.add(side.sideNo);
    if (side.party.length === 0) {
      return failure("Battle initialization requires at least one combatant on each side", {
        sideNo: side.sideNo,
      });
    }
    if (side.controllerKind === "PLAYER" ? side.playerId === null : side.playerId !== null) {
      return failure("Battle side player ownership does not match its controller", {
        sideNo: side.sideNo,
        controllerKind: side.controllerKind,
      });
    }

    const participantKind = expectedParticipantKind(side.controllerKind);
    if (participantKind === null) {
      return failure("SYSTEM-controlled sides are not supported by version-zero initialization", {
        sideNo: side.sideNo,
      });
    }
    if (side.party.some((build) => build.participantKind !== participantKind)) {
      return failure("Battle party participant kind does not match its controller", {
        sideNo: side.sideNo,
        expectedParticipantKind: participantKind,
      });
    }

    const groups = side.playerParties;
    if (groups !== undefined) {
      if (
        input.root.battleType === "PVP" ||
        side.controllerKind !== "PLAYER" ||
        groups.length === 0 ||
        groups[0]?.playerId !== side.playerId ||
        new Set(groups.map((group) => group.playerId)).size !== groups.length ||
        groups.some(
          (group) =>
            group.party.length === 0 ||
            group.party.some((build) => build.participantKind !== "PLAYER_POKEMON"),
        )
      )
        return failure("Allied initialization requires distinct player rosters on a PVE side");
    }
    const battleReadyRosters =
      groups === undefined
        ? [{ playerId: side.playerId, party: side.party }]
        : groups.map((group) => ({ playerId: group.playerId, party: group.party }));
    const exhaustedRoster = battleReadyRosters.find((group) =>
      group.party.every((build) => build.currentHp <= 0),
    );
    if (exhaustedRoster !== undefined) {
      return failure(
        "Battle initialization requires at least one battle-ready Pokemon per roster",
        {
          sideNo: side.sideNo,
          playerId: exhaustedRoster.playerId,
        },
      );
    }

    const builds = groups === undefined ? side.party : groups.flatMap((group) => group.party);
    if (
      new Set(
        builds
          .filter((build) => build.pokemonInstanceId !== null)
          .map((build) => build.pokemonInstanceId),
      ).size !== builds.filter((build) => build.pokemonInstanceId !== null).length
    ) {
      return failure("A Pokemon cannot occupy multiple allied rosters");
    }
    const sideCombatants = builds.map((build, index) =>
      buildCombatant(
        groups === undefined ? build : { ...build, rosterPosition: index + 1 },
        input.idFactory(),
        side.sideNo,
      ),
    );
    let offset = 0;
    const slots = groups?.map((group) => {
      const roster = sideCombatants.slice(offset, offset + group.party.length);
      offset += group.party.length;
      const active = roster.find((entry) => entry.currentHp > 0) ?? roster[0];
      if (active === undefined) {
        throw new Error("Allied battle roster unexpectedly resolved empty");
      }
      return {
        participantIds: roster.map((entry) => entry.participantId),
        activeParticipantId: active.participantId,
      };
    });
    const activeParticipantId =
      slots?.[0]?.activeParticipantId ??
      sideCombatants.find((entry) => entry.currentHp > 0)?.participantId ??
      sideCombatants[0]?.participantId;
    if (activeParticipantId === undefined) {
      return failure("Battle active combatant could not be selected", { sideNo: side.sideNo });
    }

    combatants.push(...sideCombatants);
    sides.push({
      sideNo: side.sideNo,
      controllerKind: side.controllerKind,
      playerId: side.playerId,
      participantIds: sideCombatants.map((entry) => entry.participantId),
      activeParticipantId,
      ...(slots === undefined ? {} : { slots }),
      result: null,
    });
  }

  const state: BattleState = {
    schemaVersion: 1,
    battleId: input.root.battleId,
    battleType: input.root.battleType,
    status: "ACTIVE",
    contentReleaseId: input.root.contentReleaseId,
    rulesetId: input.root.rulesetId,
    encounterId: input.root.encounterId,
    turnNumber: 0,
    version: 0,
    rngCounter: input.root.rngCounter.toString(),
    sides,
    combatants,
  };
  const parsed = BattleStateSchema.safeParse(state);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failure("Initial battle state failed validation", { issues: parsed.error.issues });
}
