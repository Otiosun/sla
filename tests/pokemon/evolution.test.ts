import { describe, expect, it } from "vitest";
import { evolutionRuleMatches } from "../../src/modules/pokemon/evolution.js";

describe("data-driven evolution rule matching", () => {
  it("supports the v1 LEVEL, ITEM and CONDITION subset without handler hardcodes", () => {
    expect(
      evolutionRuleMatches(
        {
          id: "level-rule",
          fromFormId: "a",
          toFormId: "b",
          triggerKind: "LEVEL",
          triggerConfig: { level: 16 },
        },
        { kind: "LEVEL", level: 16 },
      ),
    ).toBe(true);
    const itemId = "00000000-0000-4000-8000-000000000001";
    expect(
      evolutionRuleMatches(
        {
          id: "item-rule",
          fromFormId: "a",
          toFormId: "b",
          triggerKind: "ITEM",
          triggerConfig: { itemId },
        },
        { kind: "ITEM", itemId },
      ),
    ).toBe(true);
    expect(
      evolutionRuleMatches(
        {
          id: "condition-rule",
          fromFormId: "a",
          toFormId: "b",
          triggerKind: "CONDITION",
          triggerConfig: { conditionKey: "friendship-ready" },
        },
        { kind: "CONDITION", conditionKey: "friendship-ready" },
      ),
    ).toBe(true);
  });
});
