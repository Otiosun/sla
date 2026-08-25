import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  appError,
  asPlayerId,
  asPokemonInstanceId,
  err,
  mapResult,
  ok,
  parseInput,
  stableErrorCodeSchema,
  type PlayerId,
} from "../../src/platform/shared/index.js";

const PLAYER_UUID = "11111111-1111-4111-8111-111111111111";
const POKEMON_UUID = "22222222-2222-4222-8222-222222222222";

describe("shared ids, results and validation", () => {
  it("keeps domain identifiers nominally distinct", () => {
    const playerId = asPlayerId(PLAYER_UUID);
    const pokemonId = asPokemonInstanceId(POKEMON_UUID);
    const acceptsPlayer = (id: PlayerId) => id;

    expect(acceptsPlayer(playerId)).toBe(PLAYER_UUID);

    // @ts-expect-error PokemonInstanceId must never be accepted as PlayerId.
    acceptsPlayer(pokemonId);
  });

  it("rejects invalid UUIDs at the boundary", () => {
    expect(() => asPlayerId("not-a-uuid")).toThrow(/PlayerId/);
  });

  it("uses stable error codes instead of textual messages as contract", () => {
    const result = err(
      appError({
        code: "PLAYER.NOT_FOUND",
        message: "Human-readable text may evolve",
        details: { lookup: "internal" },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAYER.NOT_FOUND");
      expect(result.error.retryable).toBe(false);
    }
    expect(stableErrorCodeSchema.parse("PLAYER.NOT_FOUND")).toBe("PLAYER.NOT_FOUND");
    expect(() => stableErrorCodeSchema.parse("not stable")).toThrow();
  });

  it("maps successful results without changing failures", () => {
    expect(mapResult(ok(2), (value) => value * 3)).toEqual(ok(6));
    const failure = err(appError({ code: "TEST.FAIL", message: "fail" }));
    expect(mapResult(failure, () => "ignored")).toBe(failure);
  });

  it("normalizes Zod failures into the shared validation error", () => {
    const schema = z.object({ quantity: z.number().int().positive() });
    const invalid = parseInput(schema, { quantity: 0 });
    const valid = parseInput(schema, { quantity: 2 });

    expect(valid).toEqual(ok({ quantity: 2 }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("VALIDATION.INVALID_INPUT");
      expect(invalid.error.details?.issues[0]?.path).toBe("quantity");
    }
  });
});
