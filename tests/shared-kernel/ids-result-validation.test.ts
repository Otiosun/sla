import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  createBattleId,
  createPlayerId,
  type BattleId,
  type PlayerId,
  parsePlayerId,
} from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";
import { parseContract } from "../../src/shared-kernel/validation.js";

describe("shared kernel ids/result/validation", () => {
  it("keeps domain ids nominally distinct while using UUID values", () => {
    const playerId = createPlayerId();
    const battleId = createBattleId();

    expectTypeOf(playerId).toEqualTypeOf<PlayerId>();
    expectTypeOf(battleId).toEqualTypeOf<BattleId>();
    expect(playerId).not.toBe(battleId);
    expect(parsePlayerId(playerId)).toEqual(ok(playerId));
  });

  it("rejects malformed ids with a stable error code", () => {
    const result = parsePlayerId("not-a-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_ID");
    }
  });

  it("validates contracts through Zod and never uses text as the contract", () => {
    const schema = z.object({ level: z.number().int().min(1) });
    expect(parseContract(schema, { level: 5 })).toEqual(ok({ level: 5 }));

    const invalid = parseContract(schema, { level: 0 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("represents typed failures without throwing for expected domain outcomes", () => {
    const failure = err(appError("ACTION_INVALID", "invalid"));
    expect(failure).toEqual({
      ok: false,
      error: { code: "ACTION_INVALID", message: "invalid" },
    });
  });
});
