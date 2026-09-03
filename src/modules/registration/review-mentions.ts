import type { CommunityCapability, CommunityGroupRole } from "../community/contracts.js";

interface RegistrationReviewCommunityDirectory {
  resolveChat(input: { readonly provider: string; readonly chatRef: string }): Promise<{
    readonly known: boolean;
    readonly groupId: string | null;
    readonly role: CommunityGroupRole | null;
    readonly capabilities: readonly CommunityCapability[];
  }>;
  listReceptionStaff(groupId: string): Promise<readonly string[]>;
}

interface RegistrationReviewAdminMentionDirectory {
  whatsAppJidsForPrincipals(input: {
    readonly principalIds: readonly string[];
    readonly requiredCapability: string;
  }): Promise<readonly string[]>;
}

export interface RegistrationReviewMentionResolverDependencies {
  readonly community: RegistrationReviewCommunityDirectory;
  readonly admins: RegistrationReviewAdminMentionDirectory;
}

export class RegistrationReviewMentionResolver {
  public constructor(
    private readonly dependencies: RegistrationReviewMentionResolverDependencies,
  ) {}

  public async mentionsFor(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<readonly string[]> {
    const group = await this.dependencies.community.resolveChat(input);
    if (
      !group.known ||
      group.groupId === null ||
      group.role !== "RECEPTION" ||
      !group.capabilities.includes("admin.review")
    ) {
      return [];
    }

    const staff = [...new Set(await this.dependencies.community.listReceptionStaff(group.groupId))]
      .map((principalId) => principalId.trim())
      .filter((principalId) => principalId.length > 0)
      .sort();
    if (staff.length === 0) return [];

    return this.dependencies.admins.whatsAppJidsForPrincipals({
      principalIds: staff,
      requiredCapability: "player.registration.read",
    });
  }
}
