import { describe, expect, it, vi } from "vitest";
import {
  drawExpeditionEncounterEntry,
  prepareExpeditionEncounterWeights,
  type PinnedEligibleExpeditionEncounterPool,
  type WeightedExpeditionEncounterPool,
} from "../../src/modules/exploration/expedition-encounter-weighting.js";

const RELEASE_ID = "release-published";
const AREA_ID = "area-yun";
const KNOWN_ID = "species-shroomish";
const OTHER_ID = "species-zigzagoon";

function pool(targetWeight = 5, otherWeight = 95): PinnedEligibleExpeditionEncounterPool {
  return {
    contentReleaseId: RELEASE_ID,
    areaId: AREA_ID,
    entries: [
      {
        entryId: "encounter-shroomish",
        speciesId: KNOWN_ID,
        formId: "form-shroomish",
        weight: targetWeight,
      },
      {
        entryId: "encounter-zigzagoon",
        speciesId: OTHER_ID,
        formId: "form-zigzagoon",
        weight: otherWeight,
      },
    ],
  };
}

function prepare(
  overrides: {
    contentReleaseId?: string;
    currentAreaId?: string;
    pool?: PinnedEligibleExpeditionEncounterPool;
    knownSpeciesIds?: readonly string[];
    targetSpeciesId?: string | null;
  } = {},
) {
  return prepareExpeditionEncounterWeights({
    admission: {
      contentReleaseId: overrides.contentReleaseId ?? RELEASE_ID,
      currentAreaId: overrides.currentAreaId ?? AREA_ID,
    },
    pool: overrides.pool ?? pool(),
    knownSpeciesIds: overrides.knownSpeciesIds ?? [KNOWN_ID],
    targetSpeciesId: overrides.targetSpeciesId === undefined ? KNOWN_ID : overrides.targetSpeciesId,
  });
}

describe("V1.2 directed expedition encounters (pure, not playable)", () => {
  it("triples only a known target and retains all competing weights", () => {
    const result = prepare();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targetSpeciesId).toBe(KNOWN_ID);
    expect(result.value.entries.map((entry) => entry.effectiveWeight)).toEqual([15, 95]);
    expect(result.value.totalEffectiveWeight).toBe(110);
    // Base: 5/100. Directed: 15/110 ≈ 13.64%, NOT 15% or capped.
    expect(
      (result.value.entries[0]?.effectiveWeight ?? 0) / result.value.totalEffectiveWeight,
    ).toBeCloseTo((3 * 0.05) / (1 + 2 * 0.05), 12);
  });

  it.each([
    { base: 1, other: 99, directed: 3 / 102 },
    { base: 10, other: 90, directed: 30 / 120 },
    { base: 30, other: 70, directed: 90 / 160 },
    { base: 50, other: 50, directed: 150 / 200 },
    { base: 90, other: 10, directed: 270 / 280 },
  ])("implements exactly 3p/(1+2p) for target weight $base", ({ base, other, directed }) => {
    const result = prepare({ pool: pool(base, other) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      (result.value.entries[0]?.effectiveWeight ?? 0) / result.value.totalEffectiveWeight,
    ).toBeCloseTo(directed, 12);
  });

  it("does not cap directed probability at 50 percent", () => {
    const result = prepare({ pool: pool(30, 70) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      (result.value.entries[0]?.effectiveWeight ?? 0) / result.value.totalEffectiveWeight,
    ).toBeGreaterThan(0.5);
  });

  it("leaves free searching weights untouched", () => {
    const original = pool();
    const result = prepare({ pool: original, targetSpeciesId: null, knownSpeciesIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.effectiveWeight)).toEqual([5, 95]);
    expect(result.value.totalEffectiveWeight).toBe(100);
    expect(original.entries[0]?.weight).toBe(5);
    expect(original.entries[1]?.weight).toBe(95);
  });

  it("applies x3 to multiple catalog entries of one known species", () => {
    const original = pool();
    const result = prepare({
      pool: {
        ...original,
        entries: [
          original.entries[0]!,
          {
            entryId: "encounter-shroomish-alt-form",
            speciesId: KNOWN_ID,
            formId: "form-shroomish-alt",
            weight: 3,
          },
          original.entries[1]!,
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.effectiveWeight)).toEqual([15, 9, 95]);
    expect(result.value.totalEffectiveWeight).toBe(119);
  });

  it("uses the same non-spoiler failure for unseen and currently unavailable targets", () => {
    const unseen = prepare({ targetSpeciesId: "species-secret", knownSpeciesIds: [] });
    const knownButNotHere = prepare({
      targetSpeciesId: "species-secret",
      knownSpeciesIds: ["species-secret"],
    });
    expect(unseen).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(knownButNotHere).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    if (unseen.ok || knownButNotHere.ok) return;
    expect(unseen.error.details?.userMessage).toBe(knownButNotHere.error.details?.userMessage);
    expect(String(unseen.error.details?.userMessage)).not.toContain("species-secret");
    expect(unseen.error.details?.userMessage).toContain("RotomDex");
  });

  it.each([{ contentReleaseId: "other-release" }, { currentAreaId: "area-vila" }])(
    "rejects a pool outside the pinned World cursor %o",
    (overrides) => {
      const result = prepare(overrides);
      expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    },
  );

  it("rejects empty pools without a draw or inventing an encounter", () => {
    const original = pool();
    const result = prepare({
      targetSpeciesId: null,
      pool: { ...original, entries: [] },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it.each([0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid untrusted catalog weight %s",
    (weight) => {
      const result = prepare({ pool: pool(weight, 95) });
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    },
  );

  it("rejects duplicate entry IDs, target multiplier overflow and sum overflow", () => {
    const original = pool();
    const duplicated = prepare({
      pool: {
        ...original,
        entries: [
          original.entries[0]!,
          { ...original.entries[1]!, entryId: "encounter-shroomish" },
        ],
      },
    });
    expect(duplicated).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(prepare({ pool: pool(Number.MAX_SAFE_INTEGER, 1) })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(
      prepare({
        pool: pool(Number.MAX_SAFE_INTEGER - 1, 2),
        targetSpeciesId: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("draws exactly once from the weighted distribution with inclusive boundaries", () => {
    const prepared = prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const expected = [
      { roll: 0, speciesId: KNOWN_ID },
      { roll: 14, speciesId: KNOWN_ID },
      { roll: 15, speciesId: OTHER_ID },
      { roll: 109, speciesId: OTHER_ID },
    ];
    for (const { roll, speciesId } of expected) {
      const rng = vi.fn(() => roll);
      const actual = drawExpeditionEncounterEntry({ pool: prepared.value, nextInt: rng });
      expect(actual).toMatchObject({ ok: true, value: { speciesId } });
      expect(rng).toHaveBeenCalledExactlyOnceWith(110);
    }
    expect(prepared.value.totalEffectiveWeight).toBe(110);
  });

  it.each([-1, 110, 0.5, Number.NaN])("rejects an invalid trusted RNG return %s", (roll) => {
    const prepared = prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const actual = drawExpeditionEncounterEntry({ pool: prepared.value, nextInt: () => roll });
    expect(actual).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
  });

  it("rejects tampering with the prepared pool before invoking RNG", () => {
    const prepared = prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const tampered: WeightedExpeditionEncounterPool = {
      ...prepared.value,
      totalEffectiveWeight: prepared.value.totalEffectiveWeight + 1,
    };
    const rng = vi.fn(() => 0);
    expect(drawExpeditionEncounterEntry({ pool: tampered, nextInt: rng })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(rng).not.toHaveBeenCalled();
  });

  it("cannot create encounters, consume an item, move World or charge expedition time", () => {
    const result = prepare();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rng = vi.fn(() => 1);
    const draw = drawExpeditionEncounterEntry({ pool: result.value, nextInt: rng });
    expect(draw.ok).toBe(true);
    expect(rng).toHaveBeenCalledTimes(1);
    // Only a pure value is returned, not a persistence service, action receipt
    // or any side effect. Integration into EncounterService remains a separate gate.
    if (draw.ok)
      expect(Object.keys(draw.value).sort()).toEqual(["entryId", "formId", "speciesId", "weight"]);
  });
});
