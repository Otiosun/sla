import { describe, expect, it } from "vitest";
import type { EncounterAdminState } from "../../src/modules/encounter/admin-contracts.js";
import { encounterAdminCloseUnsafeReason } from "../../src/modules/encounter/admin-policy.js";

const baseState: EncounterAdminState = {
  encounterId: "00000000-0000-4000-8000-000000000001",
  playerId: "00000000-0000-4000-8000-000000000002",
  status: "ENGAGED",
  revision: "3",
  closedAt: null,
  battle: null,
  pendingCaptureAttemptId: null,
};

function state(overrides: Partial<EncounterAdminState>): EncounterAdminState {
  return { ...baseState, ...overrides };
}

describe("Encounter admin close safety", () => {
  it("allows normal and terminal Encounter states without unsafe linked work", () => {
    expect(encounterAdminCloseUnsafeReason(state({ status: "CREATED" }))).toBeNull();
    expect(encounterAdminCloseUnsafeReason(state({ status: "PRESENTED" }))).toBeNull();
    expect(encounterAdminCloseUnsafeReason(state({ status: "ENGAGED" }))).toBeNull();
    expect(encounterAdminCloseUnsafeReason(state({ status: "FLED" }))).toBeNull();
    expect(encounterAdminCloseUnsafeReason(state({ status: "EXPIRED" }))).toBeNull();
    expect(encounterAdminCloseUnsafeReason(state({ status: "CAPTURED" }))).toBeNull();
  });

  it("rejects capture resolution and any durable pending capture attempt", () => {
    expect(encounterAdminCloseUnsafeReason(state({ status: "CAPTURE_RESOLVING" }))).toContain(
      "capture resolution",
    );
    expect(
      encounterAdminCloseUnsafeReason(
        state({ pendingCaptureAttemptId: "00000000-0000-4000-8000-000000000003" }),
      ),
    ).toContain("capture resolution");
  });

  it("rejects missing or active Battle flows", () => {
    expect(encounterAdminCloseUnsafeReason(state({ status: "IN_BATTLE" }))).toContain(
      "no linked Battle",
    );
    for (const battleStatus of ["CREATED", "ACTIVE", "RESOLVING_TURN"] as const) {
      expect(
        encounterAdminCloseUnsafeReason(
          state({
            status: "IN_BATTLE",
            battle: {
              battleId: "00000000-0000-4000-8000-000000000004",
              status: battleStatus,
              battleType: "WILD",
              rewardClaimed: false,
            },
          }),
        ),
      ).toContain("linked Battle is active");
    }
  });

  it("rejects unsettled PvE victory but permits settled or cancelled terminal Battle", () => {
    expect(
      encounterAdminCloseUnsafeReason(
        state({
          status: "IN_BATTLE",
          battle: {
            battleId: "00000000-0000-4000-8000-000000000004",
            status: "WON",
            battleType: "WILD",
            rewardClaimed: false,
          },
        }),
      ),
    ).toContain("reward settlement");
    expect(
      encounterAdminCloseUnsafeReason(
        state({
          status: "IN_BATTLE",
          battle: {
            battleId: "00000000-0000-4000-8000-000000000004",
            status: "WON",
            battleType: "WILD",
            rewardClaimed: true,
          },
        }),
      ),
    ).toBeNull();
    expect(
      encounterAdminCloseUnsafeReason(
        state({
          status: "IN_BATTLE",
          battle: {
            battleId: "00000000-0000-4000-8000-000000000004",
            status: "CANCELLED",
            battleType: "WILD",
            rewardClaimed: false,
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects creating a new close claim for an Encounter already CLOSED", () => {
    expect(encounterAdminCloseUnsafeReason(state({ status: "CLOSED" }))).toBe(
      "Encounter is already CLOSED",
    );
  });
});
