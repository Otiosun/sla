import type { PlayerId } from "./ids.js";

export type AccessGateStage =
  | "FEATURE_AVAILABILITY"
  | "PLAYER_ELIGIBILITY"
  | "FLOW_STATE"
  | "ACTION_VALIDATION";

export type GateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: string;
      readonly message: string;
    };

export interface FeatureAvailability {
  check(featureKey: string): GateDecision;
}

export interface PlayerEligibility {
  check(playerId: PlayerId, featureKey: string): GateDecision;
}

export interface FlowStatePolicy<FlowState, Action> {
  check(flowState: FlowState, action: Action): GateDecision;
}

export interface ActionValidation<State, Action> {
  check(state: State, action: Action): GateDecision;
}

export interface AccessPolicies<FlowState, State, Action> {
  readonly featureAvailability: FeatureAvailability;
  readonly playerEligibility: PlayerEligibility;
  readonly flowState: FlowStatePolicy<FlowState, Action>;
  readonly actionValidation: ActionValidation<State, Action>;
}

export type AccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly stage: AccessGateStage;
      readonly code: string;
      readonly message: string;
    };

function denied(stage: AccessGateStage, decision: Exclude<GateDecision, { allowed: true }>): AccessDecision {
  return { allowed: false, stage, code: decision.code, message: decision.message };
}

export function evaluateAccess<FlowState, State, Action>(input: {
  readonly policies: AccessPolicies<FlowState, State, Action>;
  readonly playerId: PlayerId;
  readonly featureKey: string;
  readonly flowState: FlowState;
  readonly state: State;
  readonly action: Action;
}): AccessDecision {
  const feature = input.policies.featureAvailability.check(input.featureKey);
  if (!feature.allowed) {
    return denied("FEATURE_AVAILABILITY", feature);
  }

  const eligibility = input.policies.playerEligibility.check(input.playerId, input.featureKey);
  if (!eligibility.allowed) {
    return denied("PLAYER_ELIGIBILITY", eligibility);
  }

  const flow = input.policies.flowState.check(input.flowState, input.action);
  if (!flow.allowed) {
    return denied("FLOW_STATE", flow);
  }

  const action = input.policies.actionValidation.check(input.state, input.action);
  if (!action.allowed) {
    return denied("ACTION_VALIDATION", action);
  }

  return { allowed: true };
}
