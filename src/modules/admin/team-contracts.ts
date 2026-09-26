import { z } from "zod";

export const AdminTeamCapabilityReplaceSchema = z
  .object({
    capabilities: z.array(z.string().trim().min(1).max(128)).max(128),
    reason: z.string().trim().min(1).max(2000),
    expectedRevision: z.coerce.bigint().nonnegative(),
  })
  .strict();

export type AdminTeamCapabilityReplaceInput = z.infer<typeof AdminTeamCapabilityReplaceSchema>;

export const AdminTeamAddPrincipalSchema = z
  .object({
    playerId: z.string().uuid(),
    capabilities: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
    reason: z.string().trim().min(1).max(2000),
    receptionStaff: z.boolean().default(false),
  })
  .strict();

export type AdminTeamAddPrincipalInput = z.infer<typeof AdminTeamAddPrincipalSchema>;

export const AdminTeamReceptionStaffSchema = z
  .object({
    active: z.boolean(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export type AdminTeamReceptionStaffInput = z.infer<typeof AdminTeamReceptionStaffSchema>;

export interface AdminTeamPrincipalView {
  readonly principalId: string;
  readonly displayName: string;
  readonly status: "ACTIVE" | "DISABLED";
  readonly owner: boolean;
  readonly receptionStaff: boolean;
  readonly revision: string;
  readonly capabilities: readonly string[];
}

export interface AdminTeamView {
  readonly principals: readonly AdminTeamPrincipalView[];
  readonly capabilityCatalog: readonly {
    readonly key: string;
    readonly riskTier: number;
  }[];
}
