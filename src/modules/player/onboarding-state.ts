import { StateMachine } from "../../shared-kernel/state-machine.js";
import type { OnboardingState } from "./contracts.js";

export const onboardingStateMachine = new StateMachine<OnboardingState>({
  NEW: ["PROFILE_CREATED"],
  PROFILE_CREATED: ["REGION_SELECTED"],
  REGION_SELECTED: ["STARTER_PENDING"],
  STARTER_PENDING: ["STARTER_GRANTED"],
  STARTER_GRANTED: ["COMPLETE"],
  COMPLETE: [],
});

const ONBOARDING_STATE_ORDER: Readonly<Record<OnboardingState, number>> = {
  NEW: 0,
  PROFILE_CREATED: 1,
  REGION_SELECTED: 2,
  STARTER_PENDING: 3,
  STARTER_GRANTED: 4,
  COMPLETE: 5,
};

export function onboardingHasReached(current: OnboardingState, target: OnboardingState): boolean {
  return ONBOARDING_STATE_ORDER[current] >= ONBOARDING_STATE_ORDER[target];
}
