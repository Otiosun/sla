import type { AdminOperationRecord } from "./contracts.js";
import type { AdminOperationCompletionPort } from "./ports.js";
import type {
  CommunityGroupManageApplyPort,
  CommunityGroupManageInput,
} from "./reception-operation-definitions.js";
import {
  COMMUNITY_CAPABILITIES,
  type CommunityCapability,
} from "../community/contracts.js";
import type { CommunityService } from "../community/service.js";

interface Dependencies {
  readonly community: Pick<
    CommunityService,
    "getGroupConfiguration" | "renameGroup" | "replaceCapabilities" | "retireGroup"
  >;
  readonly completion: AdminOperationCompletionPort;
}

function expectedRevision(operation: AdminOperationRecord): number {
  if (operation.expectedRevision === null) {
    throw new Error("community.group.manage requires expectedRevision");
  }

  const value = Number(operation.expectedRevision);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid community group expectedRevision");
  }

  return value;
}

function displayName(payload: Readonly<Record<string, unknown>>): string {
  const value = payload.displayName;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("RENAME requires payload.displayName");
  }
  return value.trim();
}

function capabilityList(
  payload: Readonly<Record<string, unknown>>,
): readonly CommunityCapability[] {
  const value = payload.capabilities;
  const allowed = new Set<string>(COMMUNITY_CAPABILITIES);

  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !allowed.has(item))
  ) {
    throw new Error("REPLACE_CAPABILITIES requires valid payload.capabilities");
  }

  return [...new Set(value as CommunityCapability[])].sort();
}

export class CommunityGroupAdminService implements CommunityGroupManageApplyPort {
  public constructor(private readonly dependencies: Dependencies) {}

  public async applyCommunityGroupManage(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CommunityGroupManageInput,
  ): Promise<AdminOperationRecord> {
    const revision = expectedRevision(operation);

    const before = await this.dependencies.community.getGroupConfiguration(
      input.groupId,
    );

    if (before === null) {
      throw new Error("Community group not found");
    }

    if (input.action === "RENAME") {
      const result = await this.dependencies.community.renameGroup({
        groupId: input.groupId,
        displayName: displayName(input.payload),
        expectedRevision: revision,
      });

      if (!result.ok) throw new Error(result.error.message);

      return this.complete(
        operation,
        actorPrincipalId,
        input,
        before,
        { ...before, ...result.value },
      );
    }

    if (input.action === "REPLACE_CAPABILITIES") {
      const capabilities = capabilityList(input.payload);

      const result = await this.dependencies.community.replaceCapabilities({
        groupId: input.groupId,
        capabilities,
        expectedRevision: revision,
      });

      if (!result.ok) throw new Error(result.error.message);

      return this.complete(
        operation,
        actorPrincipalId,
        input,
        before,
        { ...before, ...result.value, capabilities },
      );
    }

    const result = await this.dependencies.community.retireGroup({
      groupId: input.groupId,
      expectedRevision: revision,
    });

    if (!result.ok) throw new Error(result.error.message);

    return this.complete(
      operation,
      actorPrincipalId,
      input,
      { groupId: input.groupId, revision },
      result.value,
    );
  }

  private async complete(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CommunityGroupManageInput,
    beforeData: Readonly<Record<string, unknown>>,
    afterData: Readonly<Record<string, unknown>>,
  ): Promise<AdminOperationRecord> {
    return this.dependencies.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "COMMUNITY_GROUP",
      resourceId: input.groupId,
      beforeData,
      afterData,
      result: {
        groupId: input.groupId,
        action: input.action,
      },
      auditTarget: {
        type: "COMMUNITY_GROUP",
        id: input.groupId,
      },
      auditMetadata: {
        sourceChannel: input.sourceChannel,
      },
    });
  }
}
