import { describe, expect, it, vi } from "vitest";
import {
  drawExpeditionResourceOutcome,
  EXPEDITION_RESOURCE_ROLL_BASIS_POINTS,
  EXPEDITION_RESOURCE_SEARCH_MINUTES,
  prepareExpeditionResourceTable,
  type PinnedExpeditionResourceTable,
  type PreparedExpeditionResourceTable,
} from "../../src/modules/exploration/expedition-resource-policy.js";

const RELEASE = "published-zhoulia";
const AREA = "area-yun";
const BALL_ID = "active-poke-ball";
const POTION_ID = "active-potion";

function exampleTable(): PinnedExpeditionResourceTable {
  return {
    contentReleaseId: RELEASE,
    areaId: AREA,
    // Baseline *illustration* only. A separate trusted catalog provider must
    // approve actual per-area odds before the runtime can use them.
    outcomes: [
      { outcomeId: "none", weightBasisPoints: 7500, reward: null },
      {
        outcomeId: "ball-1",
        weightBasisPoints: 1500,
        reward: { itemId: BALL_ID, quantity: 1 },
      },
      {
        outcomeId: "potion-1",
        weightBasisPoints: 700,
        reward: { itemId: POTION_ID, quantity: 1 },
      },
      {
        outcomeId: "ball-2",
        weightBasisPoints: 200,
        reward: { itemId: BALL_ID, quantity: 2 },
      },
      {
        outcomeId: "potion-2",
        weightBasisPoints: 100,
        reward: { itemId: POTION_ID, quantity: 2 },
      },
    ],
  };
}

function prepare(
  overrides: {
    contentReleaseId?: string;
    currentAreaId?: string;
    table?: PinnedExpeditionResourceTable;
    approvedItemIds?: readonly string[];
  } = {},
) {
  return prepareExpeditionResourceTable({
    admission: {
      contentReleaseId: overrides.contentReleaseId ?? RELEASE,
      currentAreaId: overrides.currentAreaId ?? AREA,
    },
    table: overrides.table ?? exampleTable(),
    approvedItemIds: overrides.approvedItemIds ?? [BALL_ID, POTION_ID],
  });
}

describe("V1.3 resource catalog policy (pure draft, no inventory effect)", () => {
  it("keeps the 60-minute action cost separate from randomization and real time", () => {
    expect(EXPEDITION_RESOURCE_SEARCH_MINUTES).toBe(60);
    expect(EXPEDITION_RESOURCE_ROLL_BASIS_POINTS).toBe(10_000);
  });

  it("checks a complete per-area catalog without embedding hardcoded item grants", () => {
    const result = prepare();
    expect(result).toMatchObject({
      ok: true,
      value: {
        contentReleaseId: RELEASE,
        areaId: AREA,
        totalWeightBasisPoints: 10_000,
      },
    });
  });

  it.each([
    { roll: 0, outcomeId: "none", reward: null },
    { roll: 7499, outcomeId: "none", reward: null },
    { roll: 7500, outcomeId: "ball-1", reward: { itemId: BALL_ID, quantity: 1 } },
    { roll: 8999, outcomeId: "ball-1", reward: { itemId: BALL_ID, quantity: 1 } },
    { roll: 9000, outcomeId: "potion-1", reward: { itemId: POTION_ID, quantity: 1 } },
    { roll: 9699, outcomeId: "potion-1", reward: { itemId: POTION_ID, quantity: 1 } },
    { roll: 9700, outcomeId: "ball-2", reward: { itemId: BALL_ID, quantity: 2 } },
    { roll: 9899, outcomeId: "ball-2", reward: { itemId: BALL_ID, quantity: 2 } },
    { roll: 9900, outcomeId: "potion-2", reward: { itemId: POTION_ID, quantity: 2 } },
    { roll: 9999, outcomeId: "potion-2", reward: { itemId: POTION_ID, quantity: 2 } },
  ])("makes exactly one random draw for boundary $roll", ({ roll, outcomeId, reward }) => {
    const prepared = prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const rng = vi.fn(() => roll);
    const result = drawExpeditionResourceOutcome({ table: prepared.value, nextInt: rng });
    expect(result).toMatchObject({ ok: true, value: { outcomeId, reward } });
    expect(rng).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it("keeps the illustrative 75/15/7/2/1 probabilities and expected resource values exact", () => {
    const table = exampleTable();
    const weights = table.outcomes.map((outcome) => outcome.weightBasisPoints);
    expect(weights).toEqual([7500, 1500, 700, 200, 100]);
    const ballPerSearch =
      table.outcomes
        .filter((outcome) => outcome.reward?.itemId === BALL_ID)
        .reduce(
          (sum, outcome) => sum + outcome.weightBasisPoints * (outcome.reward?.quantity ?? 0),
          0,
        ) / 10_000;
    const potionPerSearch =
      table.outcomes
        .filter((outcome) => outcome.reward?.itemId === POTION_ID)
        .reduce(
          (sum, outcome) => sum + outcome.weightBasisPoints * (outcome.reward?.quantity ?? 0),
          0,
        ) / 10_000;
    expect(ballPerSearch).toBeCloseTo(0.19, 12);
    expect(potionPerSearch).toBeCloseTo(0.09, 12);
    expect(ballPerSearch * 200 + potionPerSearch * 300).toBeCloseTo(65, 12);
  });

  it.each([{ contentReleaseId: "unpublished" }, { currentAreaId: "another-area" }])(
    "rejects catalog mismatched to current World %o",
    (overrides) => {
      expect(prepare(overrides)).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    },
  );

  it("rejects missing and unknown item identities without revealing them to the player", () => {
    const table = exampleTable();
    const missing = prepare({ table, approvedItemIds: [BALL_ID] });
    expect(missing).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    if (missing.ok) return;
    expect(String(missing.error.details?.userMessage)).not.toContain(POTION_ID);
    expect(missing.error.details?.userMessage).toContain("RotomDex");
  });

  it("rejects duplicate outcomes, invalid probabilities, missing coverage and invalid quantities", () => {
    const table = exampleTable();
    const invalidTables: PinnedExpeditionResourceTable[] = [
      { ...table, outcomes: [] },
      { ...table, outcomes: table.outcomes.slice(0, -1) },
      {
        ...table,
        outcomes: [
          table.outcomes[0]!,
          { ...table.outcomes[1]!, outcomeId: "none" },
          ...table.outcomes.slice(2),
        ],
      },
      {
        ...table,
        outcomes: table.outcomes.map((outcome, index) =>
          index === 0 ? { ...outcome, weightBasisPoints: -100 } : outcome,
        ),
      },
      {
        ...table,
        outcomes: table.outcomes.map((outcome, index) =>
          index === 0 ? { ...outcome, weightBasisPoints: 7500.5 } : outcome,
        ),
      },
      {
        ...table,
        outcomes: table.outcomes.map((outcome, index) =>
          index === 1 ? { ...outcome, reward: { itemId: BALL_ID, quantity: 0 } } : outcome,
        ),
      },
      {
        ...table,
        outcomes: table.outcomes.map((outcome, index) =>
          index === 1 ? { ...outcome, reward: { itemId: BALL_ID, quantity: 2.5 } } : outcome,
        ),
      },
    ];
    for (const candidate of invalidTables) {
      expect(prepare({ table: candidate })).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
    }
  });

  it.each([-1, 10_000, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid draw %s without inventing a resource",
    (roll) => {
      const prepared = prepare();
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(
        drawExpeditionResourceOutcome({ table: prepared.value, nextInt: () => roll }),
      ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    },
  );

  it("fails closed if the prepared table is corrupted before drawing", () => {
    const prepared = prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const tampered: PreparedExpeditionResourceTable = {
      ...prepared.value,
      outcomes: prepared.value.outcomes.slice(0, -1),
    };
    const rng = vi.fn(() => 0);
    expect(drawExpeditionResourceOutcome({ table: tampered, nextInt: rng })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(rng).not.toHaveBeenCalled();
  });

  it("returns a proposal, not an inventory credit, clock mutation or idempotency receipt", () => {
    const prepared = prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const drawn = drawExpeditionResourceOutcome({ table: prepared.value, nextInt: () => 9700 });
    expect(drawn).toMatchObject({
      ok: true,
      value: { outcomeId: "ball-2", reward: { itemId: BALL_ID, quantity: 2 } },
    });
    if (!drawn.ok) return;
    expect(Object.keys(drawn.value).sort()).toEqual(["outcomeId", "reward", "weightBasisPoints"]);
    expect(prepared.value.outcomes[0]?.reward).toBeNull();
  });
});
