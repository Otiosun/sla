import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  AssignReceptionStaffInput,
  CommunityCapability,
  CommunityChatContext,
  CommunityGroupRecord,
  CommunityGroupRole,
  RegisterCommunityGroupInput,
  RenameCommunityGroupInput,
  ReplaceCommunityCapabilitiesInput,
  ResolveCommunityChatInput,
  RetireCommunityGroupInput,
} from "./contracts.js";
import type { CommunityRepository } from "./ports.js";

const unknownContext = (): CommunityChatContext => ({
  known: false,
  groupId: null,
  role: null,
  capabilities: [],
});

function required(value: string, label: string): Result<string> {
  const normalized = value.trim();
  return normalized.length === 0
    ? err(appError("VALIDATION_FAILED", `${label} is required`))
    : ok(normalized);
}

function revision(value: number): Result<number> {
  return Number.isSafeInteger(value) && value >= 0
    ? ok(value)
    : err(appError("VALIDATION_FAILED", "Expected revision must be a non-negative integer"));
}

function capabilities(values: readonly CommunityCapability[]): readonly CommunityCapability[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export class CommunityService {
  public constructor(private readonly repository: CommunityRepository) {}

  public async resolveChat(input: ResolveCommunityChatInput): Promise<CommunityChatContext> {
    const provider = input.provider.trim();
    const chatRef = input.chatRef.trim();
    if (provider.length === 0 || chatRef.length === 0) return unknownContext();
    return this.repository.read(async (tx) => {
      const group = await tx.loadGroupByProviderRef(provider, chatRef);
      if (group === null || group.status !== "ACTIVE") return unknownContext();
      return {
        known: true,
        groupId: group.id,
        role: group.role,
        capabilities: capabilities(await tx.listCapabilities(group.id)),
      };
    });
  }

  public async registerGroup(
    input: RegisterCommunityGroupInput,
  ): Promise<Result<CommunityGroupRecord>> {
    const provider = required(input.provider, "Community provider");
    if (!provider.ok) return provider;
    const chatRef = required(input.chatRef, "Community chatRef");
    if (!chatRef.ok) return chatRef;
    const displayName = required(input.displayName, "Community display name");
    if (!displayName.ok) return displayName;
    return this.repository.transaction(async (tx) => {
      const created = await tx.insertGroup({
        provider: provider.value,
        chatRef: chatRef.value,
        role: input.role,
        displayName: displayName.value,
      });
      return created === null
        ? err(appError("REVISION_CONFLICT", "Community group already exists"))
        : ok(created);
    });
  }

  public async renameGroup(
    input: RenameCommunityGroupInput,
  ): Promise<Result<CommunityGroupRecord>> {
    const id = required(input.groupId, "Community group id");
    if (!id.ok) return id;
    const name = required(input.displayName, "Community display name");
    if (!name.ok) return name;
    const expected = revision(input.expectedRevision);
    if (!expected.ok) return expected;
    return this.repository.transaction(async (tx) => {
      const updated = await tx.renameGroup(id.value, name.value, expected.value);
      return updated === null
        ? err(appError("REVISION_CONFLICT", "Community group revision conflict"))
        : ok(updated);
    });
  }

  public async replaceCapabilities(
    input: ReplaceCommunityCapabilitiesInput,
  ): Promise<Result<CommunityGroupRecord>> {
    const id = required(input.groupId, "Community group id");
    if (!id.ok) return id;
    const expected = revision(input.expectedRevision);
    if (!expected.ok) return expected;
    return this.repository.transaction(async (tx) => {
      const updated = await tx.replaceCapabilities(
        id.value,
        capabilities(input.capabilities),
        expected.value,
      );
      return updated === null
        ? err(appError("REVISION_CONFLICT", "Community group revision conflict"))
        : ok(updated);
    });
  }

  public async retireGroup(
    input: RetireCommunityGroupInput,
  ): Promise<Result<CommunityGroupRecord>> {
    const id = required(input.groupId, "Community group id");
    if (!id.ok) return id;
    const expected = revision(input.expectedRevision);
    if (!expected.ok) return expected;
    return this.repository.transaction(async (tx) => {
      const updated = await tx.retireGroup(id.value, expected.value);
      return updated === null
        ? err(appError("REVISION_CONFLICT", "Community group revision conflict"))
        : ok(updated);
    });
  }

  public async listActiveGroupsByRole(
    role: CommunityGroupRole,
  ): Promise<readonly CommunityGroupRecord[]> {
    return this.repository.read(async (tx) =>
      (await tx.listGroupsByRole(role)).filter((group) => group.status === "ACTIVE"),
    );
  }

  public async assignReceptionStaff(input: AssignReceptionStaffInput): Promise<Result<void>> {
    const id = required(input.groupId, "Community group id");
    if (!id.ok) return id;
    const principal = required(input.adminPrincipalId, "Admin principal id");
    if (!principal.ok) return principal;
    return this.repository.transaction(async (tx) => {
      const group = await tx.loadGroupById(id.value);
      if (group === null) return err(appError("NOT_FOUND", "Community group not found"));
      if (group.status !== "ACTIVE" || group.role !== "RECEPTION") {
        return err(
          appError("INVALID_STATE_TRANSITION", "Staff assignment requires active Reception"),
        );
      }
      await tx.assignReceptionStaff(group.id, principal.value);
      return ok(undefined);
    });
  }

  public async listReceptionStaff(groupId: string): Promise<readonly string[]> {
    const id = groupId.trim();
    if (id.length === 0) return [];
    return this.repository.read(async (tx) => [...(await tx.listReceptionStaff(id))].sort());
  }
}
