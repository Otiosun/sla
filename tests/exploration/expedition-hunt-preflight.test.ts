import { describe, expect, it } from "vitest";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import {
  EXPEDITION_HUNT_SEARCH_MINUTES,
  prepareExpeditionHunt,
} from "../../src/modules/exploration/expedition-hunt-preflight.js";

const PLAYER = createPlayerId();
const EXPEDITION = "00000000-0000-4000-8000-000000000022";
const RELEASE = "release-01";
const AREA = "yun-area";
const KNOWN = "known-species";
const UNKNOWN = "unknown-species";

function prepare(
  overrides: {
    currentAreaId?: string;
    admissionAreaId?: string;
    admissionPlayerId?: PlayerId;
    phase?: "PREPARING" | "ACTIVE" | "ENDED";
    period?: "DAY" | "NIGHT";
    timeOfDay?: "DAY" | "NIGHT";
    elapsedMinutes?: number;
    consumedWeekKey?: string | null;
    endReason?: "BLACKOUT" | "CLOCK" | "VOLUNTARY" | null;
    hasActiveEncounterOrBattle?: boolean;
    targetSpeciesId?: string | null;
    knownSpeciesIds?: readonly string[];
    poolAreaId?: string;
    poolReleaseId?: string;
  } = {},
) {
  return prepareExpeditionHunt({
    expedition: {
      expeditionId: EXPEDITION,
      playerId: PLAYER,
      currentAreaId: overrides.currentAreaId ?? AREA,
      period: overrides.period ?? "DAY",
      phase: overrides.phase ?? "PREPARING",
      elapsedMinutes: overrides.elapsedMinutes ?? 0,
      consumedWeekKey:
        overrides.consumedWeekKey === undefined
          ? overrides.phase === "ACTIVE"
            ? "2026-10-19"
            : null
          : overrides.consumedWeekKey,
      endReason: overrides.endReason ?? null,
    },
    admission: {
      playerId: overrides.admissionPlayerId ?? PLAYER,
      contentReleaseId: RELEASE,
      currentAreaId: overrides.admissionAreaId ?? AREA,
    },
    pool: {
      contentReleaseId: overrides.poolReleaseId ?? RELEASE,
      areaId: overrides.poolAreaId ?? AREA,
      entries: [
        { entryId: "entry-known", speciesId: KNOWN, formId: "form-known", weight: 10 },
        { entryId: "entry-unknown", speciesId: UNKNOWN, formId: "form-unknown", weight: 90 },
      ],
    },
    knownSpeciesIds: overrides.knownSpeciesIds ?? [KNOWN],
    targetSpeciesId: overrides.targetSpeciesId === undefined ? KNOWN : overrides.targetSpeciesId,
    environment: { timeOfDay: overrides.timeOfDay ?? "DAY", surface: "LAND" },
    hasActiveEncounterOrBattle: overrides.hasActiveEncounterOrBattle ?? false,
  });
}

describe("V1.2 hunt preflight bridging V1.1 World and clock", () => {
  it("prepares a directed first timed search without spending the weekly slot", () => {
    expect(EXPEDITION_HUNT_SEARCH_MINUTES).toBe(30);
    expect(prepare()).toMatchObject({
      ok: true,
      value: {
        expeditionId: EXPEDITION,
        actionMinutes: 30,
        requiresFirstAction: true,
        pool: {
          targetSpeciesId: KNOWN,
          totalEffectiveWeight: 120,
        },
      },
    });
  });

  it("continues after a first action without consuming an extra weekly quota", () => {
    expect(prepare({ phase: "ACTIVE", elapsedMinutes: 30 })).toMatchObject({
      ok: true,
      value: {
        requiresFirstAction: false,
        actionMinutes: 30,
      },
    });
  });

  it("allows exactly 30 internal minutes remaining but refuses 29 minutes", () => {
    expect(prepare({ phase: "ACTIVE", elapsedMinutes: 690 })).toMatchObject({
      ok: true,
      value: { actionMinutes: 30 },
    });
    expect(prepare({ phase: "ACTIVE", elapsedMinutes: 691 })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it.each([
    { phase: "ENDED" as const, endReason: "CLOCK" as const, elapsedMinutes: 720 },
    { phase: "ENDED" as const, endReason: "BLACKOUT" as const, elapsedMinutes: 90 },
    { phase: "ENDED" as const, endReason: "VOLUNTARY" as const, elapsedMinutes: 90 },
    { phase: "ACTIVE" as const, elapsedMinutes: 0 },
    { phase: "PREPARING" as const, elapsedMinutes: 60 },
    { phase: "ACTIVE" as const, elapsedMinutes: Number.NaN },
  ])("refuses hunt in invalid or closed expedition phase %o", (overrides) => {
    expect(prepare(overrides)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("refuses to hunt during an existing Encounter or Battle", () => {
    expect(prepare({ hasActiveEncounterOrBattle: true })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it.each([
    { currentAreaId: "other-area" },
    { admissionAreaId: "other-area" },
    { admissionPlayerId: createPlayerId() },
    { poolAreaId: "another-area" },
    { poolReleaseId: "another-release" },
    { period: "NIGHT" as const },
  ])("fails closed for changed World, owner, catalog or period %o", (overrides) => {
    expect(prepare(overrides)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("allows the actual night expedition with matching night table", () => {
    expect(prepare({ period: "NIGHT", timeOfDay: "NIGHT" })).toMatchObject({
      ok: true,
      value: { actionMinutes: 30 },
    });
  });

  it("never allows targeting a species that this player has not seen or captured", () => {
    expect(prepare({ targetSpeciesId: UNKNOWN, knownSpeciesIds: [KNOWN] })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(prepare({ targetSpeciesId: UNKNOWN, knownSpeciesIds: [] })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("keeps no-target free search unchanged, not a guaranteed capture", () => {
    const result = prepare({ targetSpeciesId: null });
    expect(result).toMatchObject({
      ok: true,
      value: {
        pool: {
          targetSpeciesId: null,
          totalEffectiveWeight: 100,
        },
      },
    });
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      "actionMinutes",
      "expeditionId",
      "pool",
      "requiresFirstAction",
    ]);
    expect("encounterId" in result.value).toBe(false);
    expect("idempotencyKey" in result.value).toBe(false);
  });
});
