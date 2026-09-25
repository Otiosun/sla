import type { AdminTeamPrincipalView } from "./team-contracts.js";

export interface AdminTeamRepository {
  isOwner(principalId: string): Promise<boolean>;
  listPrincipals(): Promise<readonly AdminTeamPrincipalView[]>;
  listCapabilityCatalog(): Promise<readonly { key: string; riskTier: number }[]>;
  replaceCapabilities(input: {
    readonly actorPrincipalId: string;
    readonly targetPrincipalId: string;
    readonly capabilities: readonly string[];
    readonly reason: string;
    readonly expectedRevision: bigint;
  }): Promise<AdminTeamPrincipalView>;
}
