import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PokemonCenterHealingService,
  type PokemonCenterHealingPersistenceResult,
  type PokemonCenterHealingRepository,
} from "../../src/modules/world-services/healing-service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

function input() {
  return {
    playerId: createPlayerId(),
    sessionId: randomUUID(),
    sourceInboxMessageId: randomUUID(),
    correlationId: randomUUID(),
  } as const;
}

function repositoryReturning(
  result: PokemonCenterHealingPersistenceResult,
): PokemonCenterHealingRepository {
  return {
    healTeam: async () => result,
  };
}

const changed = {
  healedPokemonCount: 2,
  hpRestoredPokemonCount: 1,
  ppRestoredSlots: 3,
  statusesCleared: 1,
} as const;

describe("PokemonCenterHealingService", () => {
  it("returns the committed team recovery summary", async () => {
    const service = new PokemonCenterHealingService(
      repositoryReturning({ kind: "APPLIED", result: changed }),
    );

    await expect(service.healTeam(input())).resolves.toEqual({
      ok: true,
      value: { ...changed, replayed: false },
    });
  });

  it("replays an already committed recovery without applying it twice", async () => {
    const service = new PokemonCenterHealingService(
      repositoryReturning({ kind: "REPLAYED", result: changed }),
    );

    await expect(service.healTeam(input())).resolves.toEqual({
      ok: true,
      value: { ...changed, replayed: true },
    });
  });

  it.each([
    ["ACTIVE_BATTLE", "A Pokémon Center cannot heal a team during an active battle"],
    ["ACTIVE_ENCOUNTER", "A Pokémon Center cannot heal a team during an active encounter"],
    ["CENTER_VISIT_REQUIRED", "An active Pokémon Center visit is required"],
  ] as const)("maps %s to an invalid action", async (kind, message) => {
    const service = new PokemonCenterHealingService(repositoryReturning({ kind }));

    const result = await service.healTeam(input());

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "ACTION_INVALID", message }),
    });
  });

  it("surfaces an unsafe content/state derivation without claiming recovery", async () => {
    const service = new PokemonCenterHealingService(
      repositoryReturning({ kind: "INVALID_STATE", reason: "maximum HP cannot be derived" }),
    );

    const result = await service.healTeam(input());

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "INVALID_STATE_TRANSITION",
        message: "maximum HP cannot be derived",
      }),
    });
  });
});
