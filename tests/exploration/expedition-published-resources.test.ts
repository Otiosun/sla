import { describe, expect, it } from "vitest";
import { choosePublishedResource } from "../../src/platform/exploration/postgres-expedition-v4-resources.js";

const ITEM_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("PUBLISHED V4 resources never invent unapproved odds, items or quantities", () => {
  it("blocks missing or incomplete policies before any outcome", () => {
    for (const entries of [
      null,
      [],
      [{ kind: "ITEM", itemId: ITEM_ID, quantity: 3, weight: 9999 }],
    ]) {
      expect(choosePublishedResource(entries, 10)).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    }
  });
  it("rejects invalid quantities, duplicate item-and-quantity outcomes, extra fields and client-chosen rolls", () => {
    const invalid: unknown[] = [
      [{ kind: "ITEM", itemId: ITEM_ID, quantity: 0, weight: 10000 }],
      [{ kind: "ITEM", itemId: ITEM_ID, quantity: -1, weight: 10000 }],
      [{ kind: "ITEM", itemId: ITEM_ID, quantity: 1.5, weight: 10000 }],
      [
        { kind: "ITEM", itemId: ITEM_ID, quantity: 1, weight: 5000 },
        { kind: "ITEM", itemId: ITEM_ID, quantity: 1, weight: 5000 },
      ],
      [{ kind: "NONE", weight: 10000, itemId: ITEM_ID }],
    ];
    for (const entries of invalid) {
      expect(choosePublishedResource(entries, 0)).toMatchObject({ ok: false });
    }
    expect(choosePublishedResource([{ kind: "NONE", weight: 10000 }], 10000)).toMatchObject({
      ok: false,
    });
    expect(choosePublishedResource([{ kind: "NONE", weight: 10000 }], NaN)).toMatchObject({
      ok: false,
    });
  });
  it("uses only author-provided basis points, including an explicitly published no-result", () => {
    const entries = [
      { kind: "NONE", weight: 2500 },
      { kind: "ITEM", itemId: ITEM_ID, quantity: 3, weight: 7500 },
    ];
    expect(choosePublishedResource(entries, 2499)).toMatchObject({
      ok: true,
      value: { kind: "NONE" },
    });
    expect(choosePublishedResource(entries, 2500)).toMatchObject({
      ok: true,
      value: { kind: "ITEM", itemId: ITEM_ID, quantity: 3 },
    });
  });
});
