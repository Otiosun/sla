import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import {
  AdminTeamAddPrincipalSchema,
  AdminTeamCapabilityReplaceSchema,
  AdminTeamReceptionStaffSchema,
  type AdminTeamView,
} from "./team-contracts.js";
import type { AdminTeamRepository } from "./team-ports.js";

export class AdminTeamService {
  public constructor(private readonly repository: AdminTeamRepository) {}

  public async isOwner(principalId: string): Promise<boolean> {
    return this.repository.isOwner(principalId);
  }

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

  public async addPrincipal(actorPrincipalId: string, rawInput: unknown) {
    await this.requireOwner(actorPrincipalId);
    const parsed = AdminTeamAddPrincipalSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid admin creation request");
    }
    const capabilities = [
      ...new Set([
        "central.view",
        ...(parsed.data.receptionStaff ? ["player.registration.read"] : []),
        ...parsed.data.capabilities,
      ]),
    ].sort();
    return this.repository.addPrincipal({
      actorPrincipalId,
      playerId: parsed.data.playerId,
      capabilities,
      reason: parsed.data.reason,
      receptionStaff: parsed.data.receptionStaff,
    });
  }

  public async setReceptionStaff(
    actorPrincipalId: string,
    targetPrincipalId: string,
    rawInput: unknown,
  ) {
    await this.requireOwner(actorPrincipalId);
    const parsed = AdminTeamReceptionStaffSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid Reception staff update");
    }
    return this.repository.setReceptionStaff({
      actorPrincipalId,
      targetPrincipalId,
      active: parsed.data.active,
      reason: parsed.data.reason,
    });
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
