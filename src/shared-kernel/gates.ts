import { appError, err, ok, type Result } from "./result.js";

export interface FeatureAvailability {
  readonly enabled: boolean;
  readonly reason: string | null;
}

export interface PlayerEligibility {
  readonly eligible: boolean;
  readonly reason: string | null;
}

export interface FlowState {
  readonly state: string;
  readonly allowsAction: boolean;
  readonly reason: string | null;
}

export interface ActionValidation {
  readonly valid: boolean;
  readonly reason: string | null;
}

export interface ActionGateInput {
  readonly feature: FeatureAvailability;
  readonly player: PlayerEligibility;
  readonly flow: FlowState;
  readonly action: ActionValidation;
}

export function evaluateActionGate(input: ActionGateInput): Result<void> {
  if (!input.feature.enabled) {
    return err(
      appError("FEATURE_UNAVAILABLE", "Feature is unavailable", {
        reason: input.feature.reason,
      }),
    );
  }
  if (!input.player.eligible) {
    return err(
      appError("PLAYER_INELIGIBLE", "Player is not eligible", {
        reason: input.player.reason,
      }),
    );
  }
  if (!input.flow.allowsAction) {
    return err(
      appError("FLOW_BLOCKED", "Current flow state blocks the action", {
        reason: input.flow.reason,
        state: input.flow.state,
      }),
    );
  }
  if (!input.action.valid) {
    return err(
      appError("ACTION_INVALID", "Action is mechanically invalid", {
        reason: input.action.reason,
      }),
    );
  }
  return ok(undefined);
}
