import { describe, expect, it } from "vitest";
import {
  planExpeditionBlackoutRescue,
  type ExpeditionRescueTopology,
} from "../../src/modules/exploration/expedition-blackout-rescue.js";

const RELEASE = "active-published-world";
const VILLAGE = "area-village";
const YUN = "area-yun";
const BRIDGE = "area-bridge";
const SAFE_NORTH = "area-safe-north";

function topology(): ExpeditionRescueTopology {
  return {
    contentReleaseId: RELEASE,
    areas: [
      { areaId: VILLAGE, active: true, explorationApproved: true, safePoint: true },
      { areaId: YUN, active: true, explorationApproved: true, safePoint: false },
      { areaId: BRIDGE, active: true, explorationApproved: true, safePoint: false },
      { areaId: SAFE_NORTH, active: true, explorationApproved: true, safePoint: true },
    ],
    connections: [
      { fromAreaId: YUN, toAreaId: VILLAGE, available: true },
      { fromAreaId: VILLAGE, toAreaId: YUN, available: true },
      { fromAreaId: YUN, toAreaId: BRIDGE, available: true },
      { fromAreaId: BRIDGE, toAreaId: SAFE_NORTH, available: true },
    ],
  };
}

function plan(
  overrides: {
    expectedContentReleaseId?: string;
    currentAreaId?: string;
    topology?: ExpeditionRescueTopology;
  } = {},
) {
  return planExpeditionBlackoutRescue({
    expectedContentReleaseId: overrides.expectedContentReleaseId ?? RELEASE,
    currentAreaId: overrides.currentAreaId ?? YUN,
    topology: overrides.topology ?? topology(),
  });
}

describe("V1.5 blackout safe-point resolution (pure, no teleport)", () => {
  it("reaches only a valid nearby safe area through canonical World connections", () => {
    expect(plan()).toEqual({
      ok: true,
      value: {
        contentReleaseId: RELEASE,
        fromAreaId: YUN,
        safeAreaId: VILLAGE,
        routeAreaIds: [YUN, VILLAGE],
        requiresRelocation: true,
      },
    });
  });

  it("preserves position when the trainer already stands at an approved safe point", () => {
    expect(plan({ currentAreaId: VILLAGE })).toMatchObject({
      ok: true,
      value: {
        safeAreaId: VILLAGE,
        routeAreaIds: [VILLAGE],
        requiresRelocation: false,
      },
    });
  });

  it("does not cross blocked connections or teleport over disconnected World areas", () => {
    const original = topology();
    const disconnected = {
      ...original,
      connections: original.connections
        .filter((edge) => edge.toAreaId !== VILLAGE)
        .map((edge) => (edge.toAreaId === SAFE_NORTH ? { ...edge, available: false } : edge)),
    };
    expect(plan({ topology: disconnected })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("follows directed connections only; a reverse edge never authorizes travel", () => {
    const original = topology();
    const reversed = {
      ...original,
      connections: [{ fromAreaId: VILLAGE, toAreaId: YUN, available: true }],
    };
    expect(plan({ topology: reversed })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("uses only active and expedition-approved safe areas", () => {
    const original = topology();
    for (const invalid of [
      { ...original.areas[0]!, safePoint: false },
      { ...original.areas[0]!, active: false },
      { ...original.areas[0]!, explorationApproved: false },
    ]) {
      const custom = {
        ...original,
        areas: original.areas.map((area) => (area.areaId === VILLAGE ? invalid : area)),
        connections: original.connections.map((edge) =>
          edge.toAreaId === SAFE_NORTH ? { ...edge, available: false } : edge,
        ),
      };
      expect(plan({ topology: custom })).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    }
  });

  it("selects the fewest traversable connections rather than blindly returning starter town", () => {
    const original = topology();
    const withDirectNorthernLink = {
      ...original,
      connections: [
        ...original.connections.filter((edge) => edge.toAreaId !== VILLAGE),
        { fromAreaId: YUN, toAreaId: SAFE_NORTH, available: true },
      ],
    };
    expect(plan({ topology: withDirectNorthernLink })).toMatchObject({
      ok: true,
      value: {
        safeAreaId: SAFE_NORTH,
        routeAreaIds: [YUN, SAFE_NORTH],
      },
    });
  });

  it("breaks equal-distance ties deterministically, independent of catalog row order", () => {
    const original = topology();
    const twoDirect = {
      ...original,
      connections: [
        { fromAreaId: YUN, toAreaId: SAFE_NORTH, available: true },
        ...original.connections,
      ],
    };
    const first = plan({ topology: twoDirect });
    const reversed = plan({
      topology: { ...twoDirect, connections: [...twoDirect.connections].reverse() },
    });
    expect(first).toEqual(reversed);
    expect(first).toMatchObject({
      ok: true,
      value: { safeAreaId: SAFE_NORTH },
    });
  });

  it.each([{ expectedContentReleaseId: "wrong-release" }, { currentAreaId: "unrelated-place" }])(
    "blocks mismatched release or current World cursor %o",
    (overrides) => {
      expect(plan(overrides)).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    },
  );

  it("rejects an invalid graph instead of ignoring references to noncanonical areas", () => {
    const original = topology();
    const invalid: ExpeditionRescueTopology = {
      ...original,
      connections: [
        ...original.connections,
        { fromAreaId: YUN, toAreaId: "unknown-area", available: true },
      ],
    };
    const result = plan({ topology: invalid });
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("rejects duplicated area identities instead of selecting a contradictory safe flag", () => {
    const original = topology();
    expect(
      plan({
        topology: {
          ...original,
          areas: [
            ...original.areas,
            { areaId: VILLAGE, active: true, explorationApproved: true, safePoint: false },
          ],
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("keeps the outcome a route proposal: no ledger, penalty, XP loss or World write", () => {
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      "contentReleaseId",
      "fromAreaId",
      "requiresRelocation",
      "routeAreaIds",
      "safeAreaId",
    ]);
    expect("moneyLoss" in result.value).toBe(false);
    expect("recoveredHp" in result.value).toBe(false);
    expect("worldRevision" in result.value).toBe(false);
  });
});
