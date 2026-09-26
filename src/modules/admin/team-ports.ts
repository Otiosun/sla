import type { AdminTeamPrincipalView } from "./team-contracts.js";

export interface AdminTeamRepository {
  isOwner(principalId: string): Promise<boolean>;
  listPrincipals(): Promise<readonly AdminTeamPrincipalView[]>;
  listCapabilityCatalog(): Promise<readonly { key: string; riskTier: number }[]>;
  addPrincipal(input: {
    readonly actorPrincipalId: string;
    readonly playerId: string;
    readonly capabilities: readonly string[];
    readonly reason: string;
    readonly receptionStaff: boolean;
  }): Promise<AdminTeamPrincipalView>;
  setReceptionStaff(input: {
    readonly actorPrincipalId: string;
    readonly targetPrincipalId: string;
    readonly active: boolean;
    readonly reason: string;
  }): Promise<AdminTeamPrincipalView>;
  replaceCapabilities(input: {
    readonly actorPrincipalId: string;
    readonly targetPrincipalId: string;
    readonly capabilities: readonly string[];
    readonly reason: string;
    readonly expectedRevision: bigint;
  }): Promise<AdminTeamPrincipalView>;
}
