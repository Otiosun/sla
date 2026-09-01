import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { PlayerAccessRecord, PlayerAccessStatus } from "../registration/player-access-ports.js";
import type { CommunityCapability, CommunityChatContext } from "./contracts.js";

export interface CommandPolicyContext {
  readonly group: CommunityChatContext;
  readonly playerAccess: PlayerAccessRecord;
  readonly adminCapabilities: readonly string[];
  readonly mechanicalReady: boolean;
}

export interface CommandPolicyRequirement {
  readonly requiredGroupCapabilities?: readonly CommunityCapability[];
  readonly allowedPlayerAccess?: readonly PlayerAccessStatus[];
  readonly requiredAdminCapability?: string;
  readonly requiresMechanicalReady?: boolean;
}

export function evaluateCommandPolicy(
  context: CommandPolicyContext,
  requirement: CommandPolicyRequirement,
): Result<void> {
  if (!context.group.known) {
    return err(appError("ACTION_INVALID", "This command is not enabled in an unknown group"));
  }

  for (const capability of requirement.requiredGroupCapabilities ?? []) {
    if (!context.group.capabilities.includes(capability)) {
      return err(appError("ACTION_INVALID", "This command is not enabled in this group"));
    }
  }

  if (
    requirement.allowedPlayerAccess !== undefined &&
    !requirement.allowedPlayerAccess.includes(context.playerAccess.status)
  ) {
    return err(appError("PLAYER_INELIGIBLE", "Player access state does not allow this command"));
  }

  if (
    requirement.requiredAdminCapability !== undefined &&
    !context.adminCapabilities.includes(requirement.requiredAdminCapability)
  ) {
    return err(appError("PLAYER_INELIGIBLE", "Administrative capability is required"));
  }

  if (requirement.requiresMechanicalReady === true && !context.mechanicalReady) {
    return err(appError("FLOW_BLOCKED", "Player mechanical state is not ready for this command"));
  }

  return ok(undefined);
}
