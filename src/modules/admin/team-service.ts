import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import {
  AdminTeamCapabilityReplaceSchema,
  type AdminTeamView,
} from "./team-contracts.js";
import type { AdminTeamRepository } from "./team-ports.js";

export class AdminTeamService {
  public constructor(private readonly repository: AdminTeamRepository) {}

  private async requireOwner(principalId: string): Promise<void> {
    if (!(await this.repository.isOwner(principalId))) {
      throw new AdminError(
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Only protected owners can manage administrative powers",
      );
    }
  }

  public async list(actorPrincipalId: string): Promise<AdminTeamView> {
    await this.requireOwner(actorPrincipalId);
    const [principals, capabilityCatalog] = await Promise.all([
      this.repository.listPrincipals(),
      this.repository.listCapabilityCatalog(),
    ]);
    return { principals, capabilityCatalog };
  }

  public async replaceCapabilities(
    actorPrincipalId: string,
    targetPrincipalId: string,
    rawInput: unknown,
  ) {
    await this.requireOwner(actorPrincipalId);
    const parsed = AdminTeamCapabilityReplaceSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid admin capability update");
    }
    const capabilities = [...new Set(parsed.data.capabilities)].sort();
    return this.repository.replaceCapabilities({
      actorPrincipalId,
      targetPrincipalId,
      capabilities,
      reason: parsed.data.reason,
      expectedRevision: parsed.data.expectedRevision,
    });
  }
}
