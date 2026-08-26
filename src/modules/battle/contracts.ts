import { z } from "zod";

export const BattleStatusSchema = z.enum([
  "CREATED",
  "ACTIVE",
  "RESOLVING_TURN",
  "WON",
  "LOST",
  "FLED",
  "DRAW",
  "CANCELLED",
]);
export type BattleStatus = z.infer<typeof BattleStatusSchema>;

export const BattleTypeSchema = z.enum(["WILD", "NPC", "PVP"]);
export type BattleType = z.infer<typeof BattleTypeSchema>;

export const ControllerKindSchema = z.enum(["PLAYER", "WILD", "NPC", "SYSTEM"]);
export type ControllerKind = z.infer<typeof ControllerKindSchema>;

export const ParticipantKindSchema = z.enum(["PLAYER_POKEMON", "WILD_POKEMON", "NPC_POKEMON"]);
export type ParticipantKind = z.infer<typeof ParticipantKindSchema>;

export const MajorStatusKeySchema = z.enum(["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"]);
export type MajorStatusKey = z.infer<typeof MajorStatusKeySchema>;

export const BattleStatKeySchema = z.enum([
  "ATTACK",
  "DEFENSE",
  "SP_ATTACK",
  "SP_DEFENSE",
  "SPEED",
  "ACCURACY",
  "EVASION",
]);
export type BattleStatKey = z.infer<typeof BattleStatKeySchema>;

const uuid = z.string().uuid();
const positiveStat = z.number().int().positive().max(65_535);
const iv = z.number().int().min(0).max(31);
const stage = z.number().int().min(-6).max(6);

export const BattleStatsSchema = z
  .object({
    hp: positiveStat,
    attack: positiveStat,
    defense: positiveStat,
    spAttack: positiveStat,
    spDefense: positiveStat,
    speed: positiveStat,
  })
  .strict();
export type BattleStats = z.infer<typeof BattleStatsSchema>;

export const BattleIvsSchema = z
  .object({ hp: iv, attack: iv, defense: iv, spAttack: iv, spDefense: iv, speed: iv })
  .strict();
export type BattleIvs = z.infer<typeof BattleIvsSchema>;

export const BattleStagesSchema = z
  .object({
    attack: stage,
    defense: stage,
    spAttack: stage,
    spDefense: stage,
    speed: stage,
    accuracy: stage,
    evasion: stage,
  })
  .strict();
export type BattleStages = z.infer<typeof BattleStagesSchema>;

export const EMPTY_BATTLE_STAGES: BattleStages = Object.freeze({
  attack: 0,
  defense: 0,
  spAttack: 0,
  spDefense: 0,
  speed: 0,
  accuracy: 0,
  evasion: 0,
});

export const BattleMoveSnapshotSchema = z
  .object({
    slotNo: z.number().int().min(1).max(4),
    moveId: uuid,
    typeId: uuid,
    typeSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    category: z.enum(["PHYSICAL", "SPECIAL", "STATUS"]),
    power: z.number().int().min(0).max(999).nullable(),
    accuracy: z.number().int().min(0).max(100).nullable(),
    priority: z.number().int().min(-10).max(10),
    maxPp: z.number().int().positive().max(99).nullable(),
    ppCurrent: z.number().int().min(0).max(99).nullable(),
    effectKey: z.string().min(1).max(64).nullable(),
    effectConfig: z.unknown(),
    flags: z.object({ makesContact: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((move, context) => {
    if (move.maxPp !== null && move.ppCurrent !== null && move.ppCurrent > move.maxPp) {
      context.addIssue({ code: "custom", path: ["ppCurrent"], message: "PP cannot exceed maxPp" });
    }
  });
export type BattleMoveSnapshot = z.infer<typeof BattleMoveSnapshotSchema>;

export const BattleNatureSchema = z
  .object({
    natureId: uuid,
    increasedStat: z.enum(["ATTACK", "DEFENSE", "SP_ATTACK", "SP_DEFENSE", "SPEED"]).nullable(),
    decreasedStat: z.enum(["ATTACK", "DEFENSE", "SP_ATTACK", "SP_DEFENSE", "SPEED"]).nullable(),
  })
  .strict();
export type BattleNature = z.infer<typeof BattleNatureSchema>;

export const BattleAbilitySchema = z
  .object({ abilityId: uuid, effectKey: z.string().min(1).max(64).nullable(), effectConfig: z.unknown() })
  .strict();
export type BattleAbility = z.infer<typeof BattleAbilitySchema>;

export const BattleMajorStatusSchema = z
  .object({ key: MajorStatusKeySchema, counter: z.number().int().min(0).max(10).nullable() })
  .strict();
export type BattleMajorStatus = z.infer<typeof BattleMajorStatusSchema>;

export const BattleVolatileSchema = z
  .object({ flinch: z.boolean(), confusionTurns: z.number().int().min(0).max(10) })
  .strict();
export type BattleVolatile = z.infer<typeof BattleVolatileSchema>;

export const BattleCombatantSchema = z
  .object({
    participantId: uuid,
    sideNo: z.number().int().positive().max(16),
    rosterPosition: z.number().int().positive().max(64),
    participantKind: ParticipantKindSchema,
    pokemonInstanceId: uuid.nullable(),
    formId: uuid,
    speciesId: uuid,
    level: z.number().int().min(1).max(100),
    type1Id: uuid,
    type1Slug: z.string().min(1).max(64),
    type2Id: uuid.nullable(),
    type2Slug: z.string().min(1).max(64).nullable(),
    baseStats: BattleStatsSchema,
    ivs: BattleIvsSchema,
    nature: BattleNatureSchema,
    ability: BattleAbilitySchema,
    moves: z.array(BattleMoveSnapshotSchema).max(4),
    maxHp: z.number().int().positive().max(999_999),
    currentHp: z.number().int().min(0).max(999_999),
    majorStatus: BattleMajorStatusSchema.nullable(),
    stages: BattleStagesSchema,
    volatile: BattleVolatileSchema,
  })
  .strict()
  .superRefine((combatant, context) => {
    if (combatant.currentHp > combatant.maxHp) {
      context.addIssue({ code: "custom", path: ["currentHp"], message: "currentHp cannot exceed maxHp" });
    }
    const slots = new Set(combatant.moves.map((move) => move.slotNo));
    if (slots.size !== combatant.moves.length) {
      context.addIssue({ code: "custom", path: ["moves"], message: "move slots must be unique" });
    }
  });
export type BattleCombatant = z.infer<typeof BattleCombatantSchema>;

export const BattleSideSchema = z
  .object({
    sideNo: z.number().int().positive().max(16),
    controllerKind: ControllerKindSchema,
    playerId: uuid.nullable(),
    participantIds: z.array(uuid).min(1).max(64),
    activeParticipantId: uuid,
    result: z.enum(["WON", "LOST", "FLED", "DRAW", "CANCELLED"]).nullable(),
  })
  .strict();
export type BattleSide = z.infer<typeof BattleSideSchema>;

export const BattleStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    battleId: uuid,
    battleType: BattleTypeSchema,
    status: BattleStatusSchema,
    contentReleaseId: uuid,
    rulesetId: uuid,
    encounterId: uuid.nullable(),
    turnNumber: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    rngCounter: z.string().regex(/^\d+$/),
    sides: z.array(BattleSideSchema).min(2).max(16),
    combatants: z.array(BattleCombatantSchema).min(2).max(128),
  })
  .strict()
  .superRefine((state, context) => {
    const combatantIds = new Set(state.combatants.map((entry) => entry.participantId));
    const sideNos = new Set<number>();
    for (const [index, side] of state.sides.entries()) {
      if (sideNos.has(side.sideNo)) {
        context.addIssue({ code: "custom", path: ["sides", index, "sideNo"], message: "sideNo must be unique" });
      }
      sideNos.add(side.sideNo);
      if (!side.participantIds.includes(side.activeParticipantId)) {
        context.addIssue({ code: "custom", path: ["sides", index, "activeParticipantId"], message: "active participant must belong to side" });
      }
      for (const participantId of side.participantIds) {
        if (!combatantIds.has(participantId)) {
          context.addIssue({ code: "custom", path: ["sides", index, "participantIds"], message: "side references missing combatant" });
        }
      }
    }
    for (const [index, combatant] of state.combatants.entries()) {
      const side = state.sides.find((entry) => entry.sideNo === combatant.sideNo);
      if (side === undefined || !side.participantIds.includes(combatant.participantId)) {
        context.addIssue({ code: "custom", path: ["combatants", index, "sideNo"], message: "combatant is not owned by its side" });
      }
    }
  });
export type BattleState = z.infer<typeof BattleStateSchema>;

const ActionBaseSchema = z.object({ actorParticipantId: uuid });
export const BattleActionSchema = z.discriminatedUnion("type", [
  ActionBaseSchema.extend({
    type: z.literal("USE_MOVE"),
    moveSlot: z.number().int().min(1).max(4),
    targetParticipantId: uuid,
  }).strict(),
  ActionBaseSchema.extend({ type: z.literal("SWITCH"), switchToParticipantId: uuid }).strict(),
  ActionBaseSchema.extend({ type: z.literal("USE_ITEM"), itemId: uuid, targetParticipantId: uuid.optional() }).strict(),
  ActionBaseSchema.extend({ type: z.literal("FLEE") }).strict(),
]);
export type BattleAction = z.infer<typeof BattleActionSchema>;

export const BATTLE_EVENT_TYPES = [
  "TurnStarted",
  "MoveUsed",
  "MoveMissed",
  "DamageApplied",
  "StatusApplied",
  "StatusCleared",
  "StatStageChanged",
  "AbilityTriggered",
  "ActionBlocked",
  "ActionSkipped",
  "Switched",
  "Fainted",
  "BattleEnded",
  "TurnResolved",
] as const;
export type BattleEventType = (typeof BATTLE_EVENT_TYPES)[number];

export interface BattleEvent {
  readonly type: BattleEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ResolvedTurn {
  readonly state: BattleState;
  readonly events: readonly BattleEvent[];
}

export interface BattleError {
  readonly code: "BATTLE_STATE_INVALID" | "BATTLE_ACTION_INVALID" | "BATTLE_NOT_ACTIVE";
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
