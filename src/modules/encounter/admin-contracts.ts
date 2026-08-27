import { z } from "zod";
import { BattleStatusSchema, BattleTypeSchema } from "../battle/contracts.js";
import { EncounterStatusSchema } from "./contracts.js";
import type { EncounterId, PlayerId } from "../../shared-kernel/ids.js";

const uuidSchema = z.string().uuid();
const revisionSchema = z.string().regex(/^[0-9]+$/);

export const EncounterAdminStateSchema = z
  .object({
    encounterId: uuidSchema,
    playerId: uuidSchema,
    status: EncounterStatusSchema,
    revision: revisionSchema,
    closedAt: z.string().datetime({ offset: true }).nullable(),
    battle: z
      .object({
        battleId: uuidSchema,
        status: BattleStatusSchema,
        battleType: BattleTypeSchema,
        rewardClaimed: z.boolean(),
      })
      .strict()
      .nullable(),
    pendingCaptureAttemptId: uuidSchema.nullable(),
  })
  .strict();
export type EncounterAdminState = z.infer<typeof EncounterAdminStateSchema>;

export const EncounterAdminCloseResultSchema = z
  .object({
    encounterId: uuidSchema,
    operationKind: z.literal("CLOSE"),
    beforeRevision: revisionSchema,
    afterRevision: revisionSchema,
    beforeState: EncounterAdminStateSchema,
    afterState: EncounterAdminStateSchema,
    replayed: z.boolean(),
  })
  .strict();
export type EncounterAdminCloseResult = z.infer<typeof EncounterAdminCloseResultSchema>;

export interface EncounterAdminCloseInput {
  readonly playerId: PlayerId;
  readonly encounterId: EncounterId;
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly metadata: {
    readonly sourceType: "ADMIN_OPERATION";
    readonly sourceId: string;
    readonly reason: string;
    readonly actorType: "ADMIN";
    readonly actorId: string;
  };
}
