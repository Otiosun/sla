import { z } from "zod";
import { BattleMajorStatusSchema } from "../battle/contracts.js";

const uuid = z.string().uuid();

export const AdminBattleTargetSchema = z
  .object({
    playerId: uuid,
    battleId: uuid,
  })
  .strict();
export type AdminBattleTarget = z.infer<typeof AdminBattleTargetSchema>;

export const AdminBattleForceCancelInputSchema = AdminBattleTargetSchema;
export type AdminBattleForceCancelInput = z.infer<typeof AdminBattleForceCancelInputSchema>;

export const AdminBattleCorrectStateInputSchema = z
  .object({
    playerId: uuid,
    battleId: uuid,
    participantId: uuid,
    currentHp: z.number().int().min(1).max(999_999).optional(),
    majorStatus: BattleMajorStatusSchema.nullable().optional(),
    movePp: z
      .object({
        slotNo: z.number().int().min(1).max(4),
        ppCurrent: z.number().int().min(0).max(99),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.currentHp === undefined &&
      value.majorStatus === undefined &&
      value.movePp === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Battle state correction requires at least one allowlisted mechanical field",
      });
    }
  });
export type AdminBattleCorrectStateInput = z.infer<typeof AdminBattleCorrectStateInputSchema>;
