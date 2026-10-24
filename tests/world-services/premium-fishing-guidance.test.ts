import { describe, expect, it, vi } from "vitest";
import { FishingService } from "../../src/modules/world-services/fishing-service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const playerId = createPlayerId();
function run(reservation: object) {
  const createOrReplay = vi.fn();
  const service = new FishingService(
    { reserveAttempt: async () => reservation as never },
    { createOrReplay },
    { randomFloat: () => 0, randomInt: () => 0 },
  );
  return {
    result: service.attempt({ playerId, idempotencyKey: "fishing-safety" }),
    createOrReplay,
  };
}

describe("Premium fishing player guidance", () => {
  it("explains the daily limit without creating an encounter", async () => {
    const { result, createOrReplay } = run({
      kind: "DAILY_LIMIT_REACHED",
      playerId,
      dailyLimit: 5,
      remainingAttempts: 0,
    });
    expect(await result).toMatchObject({
      ok: false,
      error: { details: { userMessage: expect.stringContaining("5 pescarias") } },
    });
    expect(createOrReplay).not.toHaveBeenCalled();
  });

  it.each([
    ["Player is not active", "cadastro"],
    ["Fishing is not configured for the current area", "/onde"],
    ["Player has an incompatible active encounter or battle", "batalha"],
    ["Fishing RARE encounter pool is not configured for the current area", "equipe"],
    ["Unexpected reason", "localização"],
  ])("explains unavailable fishing safely: %s", async (reason, guidance) => {
    const { result, createOrReplay } = run({
      kind: "FISHING_UNAVAILABLE",
      playerId,
      reason,
    });
    expect(await result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_INVALID",
        details: { reason, userMessage: expect.stringContaining(guidance) },
      },
    });
    expect(createOrReplay).not.toHaveBeenCalled();
  });
});
