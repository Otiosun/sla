import { describe, expect, it } from "vitest";
import { evaluateActionGate } from "../../src/shared-kernel/gates.js";
import { StateMachine } from "../../src/shared-kernel/state-machine.js";

type OnboardingState = "NEW" | "STARTER_PENDING" | "COMPLETE";

const onboarding = new StateMachine<OnboardingState>({
  NEW: ["STARTER_PENDING"],
  STARTER_PENDING: ["COMPLETE"],
  COMPLETE: [],
});

describe("state machines and access gates", () => {
  it("allows only declared state transitions", () => {
    expect(onboarding.transition("NEW", "STARTER_PENDING")).toEqual({
      ok: true,
      value: "STARTER_PENDING",
    });

    const invalid = onboarding.transition("NEW", "COMPLETE");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("INVALID_STATE_TRANSITION");
    }
  });

  it("keeps FeatureAvailability separate from completed onboarding", () => {
    const result = evaluateActionGate({
      feature: { enabled: false, reason: "maintenance" },
      player: { eligible: true, reason: null },
      flow: { state: "ONBOARDING_COMPLETE", allowsAction: true, reason: null },
      action: { valid: true, reason: null },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FEATURE_UNAVAILABLE");
    }
  });

  it("reports the precise owner of a blocked action", () => {
    const playerBlocked = evaluateActionGate({
      feature: { enabled: true, reason: null },
      player: { eligible: false, reason: "suspended" },
      flow: { state: "READY", allowsAction: true, reason: null },
      action: { valid: true, reason: null },
    });
    expect(playerBlocked.ok ? null : playerBlocked.error.code).toBe("PLAYER_INELIGIBLE");

    const flowBlocked = evaluateActionGate({
      feature: { enabled: true, reason: null },
      player: { eligible: true, reason: null },
      flow: { state: "IN_BATTLE", allowsAction: false, reason: "travel blocked" },
      action: { valid: true, reason: null },
    });
    expect(flowBlocked.ok ? null : flowBlocked.error.code).toBe("FLOW_BLOCKED");
  });
});
