import { describe, expect, it } from "vitest";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import {
  inspectAutonomousFacilityAction,
  type AutonomousFacilityAction,
} from "../../src/modules/exploration/expedition-facility-admission.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "area-vila";
const RELEASE_ID = "published-release";

function admission(
  overrides: {
    playerId?: typeof PLAYER_ID;
    locationPlayerId?: typeof PLAYER_ID;
    areaId?: string;
    worldAreaId?: string;
    contentReleaseId?: string;
    phase?: "PREPARING" | "ACTIVE" | "ENDED";
    endReason?: "VOLUNTARY" | "BLACKOUT" | "CLOCK" | null;
    elapsedMinutes?: number;
    hasActiveBattle?: boolean;
    action?: AutonomousFacilityAction;
    facilities?: ("POKEMON_CENTER" | "POKEMART")[];
    requiresRelocation?: boolean;
  } = {},
) {
  return inspectAutonomousFacilityAction({
    expedition: {
      playerId: overrides.playerId ?? PLAYER_ID,
      currentAreaId: overrides.areaId ?? AREA_ID,
      phase: overrides.phase ?? "ACTIVE",
      endReason: overrides.endReason ?? null,
      elapsedMinutes: overrides.elapsedMinutes ?? 30,
    },
    location: {
      playerId: overrides.locationPlayerId ?? PLAYER_ID,
      areaId: overrides.worldAreaId ?? AREA_ID,
      contentReleaseId: overrides.contentReleaseId ?? RELEASE_ID,
      facilities: overrides.facilities ?? ["POKEMON_CENTER", "POKEMART"],
      requiresRelocation: overrides.requiresRelocation ?? false,
    },
    pinnedContentReleaseId: RELEASE_ID,
    action: overrides.action ?? "HEAL",
    hasActiveBattle: overrides.hasActiveBattle ?? false,
  });
}

describe("V1.4 autonomous facility admission (pure, not a Journey policy replacement)", () => {
  it("admits canonical healing in a valid ACTIVE session for 30 internal minutes", () => {
    expect(admission()).toEqual({
      ok: true,
      value: {
        action: "HEAL",
        requiredFacility: "POKEMON_CENTER",
        actionMinutes: 30,
      },
    });
  });

  it("admits shopping as a zero-minute service, not a free item or payment", () => {
    expect(admission({ action: "SHOP" })).toEqual({
      ok: true,
      value: {
        action: "SHOP",
        requiredFacility: "POKEMART",
        actionMinutes: 0,
      },
    });
  });

  it.each([
    { phase: "PREPARING" as const, elapsedMinutes: 0 },
    { phase: "ENDED" as const, endReason: "VOLUNTARY" as const },
    { phase: "ENDED" as const, endReason: "BLACKOUT" as const },
    { phase: "ENDED" as const, endReason: "CLOCK" as const },
    { elapsedMinutes: 0 },
    { elapsedMinutes: 720 },
    { elapsedMinutes: Number.NaN },
  ])("blocks service outside a legitimate ACTIVE timed expedition %o", (overrides) => {
    expect(admission(overrides)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("keeps the independent Journey admission rule untouched", () => {
    // No active autonomous expedition => this helper refuses the facility.
    // The 50-word Journey service policy is deliberately NOT modified here.
    expect(admission({ phase: "PREPARING", elapsedMinutes: 0 })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it.each([
    { areaId: "current-area", worldAreaId: "stale-area" },
    { contentReleaseId: "unpublished" },
    { requiresRelocation: true },
    { locationPlayerId: createPlayerId() },
  ])("fails closed on World ownership, location or release divergence %o", (overrides) => {
    expect(admission(overrides)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it.each(["HEAL", "SHOP"] as const)("refuses %s while a canonical battle is active", (action) => {
    const result = admission({ action, hasActiveBattle: true });
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    if (!result.ok) expect(result.error.details?.userMessage).toContain("batalha");
  });

  it.each([
    { action: "HEAL" as const, facilities: ["POKEMART" as const] },
    { action: "SHOP" as const, facilities: ["POKEMON_CENTER" as const] },
  ])("does not invent a missing service in the current area %o", (overrides) => {
    expect(admission(overrides)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("denies a World location whose optional facilities field is absent", () => {
    const result = inspectAutonomousFacilityAction({
      expedition: {
        playerId: PLAYER_ID,
        currentAreaId: AREA_ID,
        phase: "ACTIVE",
        endReason: null,
        elapsedMinutes: 30,
      },
      location: {
        playerId: PLAYER_ID,
        areaId: AREA_ID,
        contentReleaseId: RELEASE_ID,
        requiresRelocation: false,
      },
      pinnedContentReleaseId: RELEASE_ID,
      action: "HEAL",
      hasActiveBattle: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("respects the remaining expedition clock without charging anything in this preflight", () => {
    const notEnough = admission({ elapsedMinutes: 691, action: "HEAL" });
    expect(notEnough).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    const exact = admission({ elapsedMinutes: 690, action: "HEAL" });
    expect(exact).toMatchObject({ ok: true, value: { actionMinutes: 30 } });
    const zeroCost = admission({ elapsedMinutes: 719, action: "SHOP" });
    expect(zeroCost).toMatchObject({ ok: true, value: { actionMinutes: 0 } });
  });

  it("returns no player money, healing state, items, World movement or receipt IDs", () => {
    const healed = admission({ action: "HEAL" });
    expect(healed.ok).toBe(true);
    if (!healed.ok) return;
    expect(Object.keys(healed.value).sort()).toEqual([
      "action",
      "actionMinutes",
      "requiredFacility",
    ]);
  });
});
