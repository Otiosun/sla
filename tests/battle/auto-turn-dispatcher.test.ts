import { describe, expect, it, vi } from "vitest";
import { AutoTurnDispatcher } from "../../src/modules/battle/auto-turn-dispatcher.js";

describe("AUTO turn dispatcher", () => {
  it("takes one bounded snapshot and continues after a failed transaction", async () => {
    const read = vi.fn().mockResolvedValue(["broken", "healthy", "next-tick"]);
    const result = {
      ok: false as const,
      error: { code: "BATTLE_RNG_UNAVAILABLE" as const, message: "key unavailable" },
    };
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error("database disconnected"))
      .mockResolvedValue(result);
    const dispatcher = new AutoTurnDispatcher({ listLockedAutoWindows: read }, { resolve });
    const outcomes = await dispatcher.runOnce({ limit: 2 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls).toEqual([["broken"], ["healthy"]]);
    expect(outcomes).toEqual([
      { windowId: "broken", error: expect.any(Error) },
      { windowId: "healthy", result },
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid limit %s before reads",
    async (limit) => {
      const read = vi.fn();
      const dispatcher = new AutoTurnDispatcher(
        { listLockedAutoWindows: read },
        { resolve: vi.fn() },
      );
      await expect(dispatcher.runOnce({ limit })).rejects.toThrow("positive safe integer");
      expect(read).not.toHaveBeenCalled();
    },
  );
});
