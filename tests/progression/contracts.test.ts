import { describe, expect, it } from "vitest";
import { EvolvePokemonInputSchema } from "../../src/modules/progression/contracts.js";

const base = {
  playerId: "00000000-0000-4000-8000-000000000001",
  pokemonInstanceId: "00000000-0000-4000-8000-000000000002",
  idempotencyKey: "evolve-1",
  correlationId: "00000000-0000-4000-8000-000000000003",
};

describe("progression public boundary", () => {
  it("rejects client-controlled CONDITION evolution evidence", () => {
    const parsed = EvolvePokemonInputSchema.safeParse({
      ...base,
      trigger: { kind: "CONDITION", conditionKey: "friendship-ready" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts only public LEVEL or server-priced ITEM requests", () => {
    expect(EvolvePokemonInputSchema.safeParse({ ...base, trigger: { kind: "LEVEL" } }).success).toBe(
      true,
    );
    expect(
      EvolvePokemonInputSchema.safeParse({
        ...base,
        trigger: { kind: "ITEM", itemId: "00000000-0000-4000-8000-000000000004" },
      }).success,
    ).toBe(true);
  });
});
