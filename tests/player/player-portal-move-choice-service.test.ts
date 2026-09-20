import { describe, expect, it, vi } from "vitest";
import type { PlayerProfileView } from "../../src/modules/player/contracts.js";
import { PlayerPortalMoveChoiceService } from "../../src/modules/player-portal/move-choice-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const pokemonInstanceId = createPokemonInstanceId();
const identity = { provider: "baileys", externalId: "player@test" } as const;
const choiceId = "11111111-1111-4111-8111-111111111111";
const moveId = "22222222-2222-4222-8222-222222222222";

const profile: PlayerProfileView = {
  playerId,
  playerStatus: "ACTIVE",
  trainerName: "Natan",
  originRegionId: null,
  locale: "pt-BR",
  trainerLevel: 1,
  progressionPoints: 0n,
  onboardingState: "COMPLETE",
  contentReleaseId: "33333333-3333-4333-8333-333333333333",
  rulesetId: "44444444-4444-4444-8444-444444444444",
  starterPokemonInstanceId: pokemonInstanceId,
  team: [],
};

const choice = {
  choiceId,
  pokemonInstanceId,
  pokemonDisplayName: "Charmander",
  learnLevel: 16,
  moveId,
  moveDisplayName: "Dragon Rage",
  currentMoves: [
    {
      slotNo: 1,
      moveId: "55555555-5555-4555-8555-555555555555",
      displayName: "Scratch",
    },
    {
      slotNo: 2,
      moveId: "66666666-6666-4666-8666-666666666666",
      displayName: "Growl",
    },
  ],
};

function service(options: {
  activeBattleId?: string | null;
  choices?: readonly typeof choice[];
  resolveMoveChoice?: ReturnType<typeof vi.fn>;
} = {}) {
  const resolveMoveChoice =
    options.resolveMoveChoice ??
    vi.fn(async () =>
      ok({
        choiceId,
        pokemonInstanceId,
        moveId,
        status: "RESOLVED" as const,
        replacedSlotNo: 2,
        replayed: false,
      }),
    );

  return {
    resolveMoveChoice,
    service: new PlayerPortalMoveChoiceService({
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }),
      },
      profiles: { getProfile: async () => ok(profile) },
      reads: {
        listPendingMoveChoices: async () => options.choices ?? [choice],
        activeBattleId: async () => options.activeBattleId ?? null,
      },
      progression: { resolveMoveChoice },
    }),
  };
}

describe("PlayerPortalMoveChoiceService", () => {
  it("lists authoritative pending choices and exposes battle blocking", async () => {
    const { service: subject } = service({ activeBattleId: "battle-1" });

    await expect(subject.list(identity)).resolves.toEqual({
      ok: true,
      value: { blockedByBattle: true, choices: [choice] },
    });
  });

  it("resolves an owned pending choice through canonical progression", async () => {
    const { service: subject, resolveMoveChoice } = service();

    const result = await subject.resolve(identity, {
      choiceId,
      replaceSlotNo: 2,
    });

    expect(result.ok).toBe(true);
    expect(resolveMoveChoice).toHaveBeenCalledOnce();
    expect(resolveMoveChoice.mock.calls[0]?.[0]).toMatchObject({
      choiceId,
      playerId,
      replaceSlotNo: 2,
    });
  });

  it("supports skipping the pending move", async () => {
    const resolveMoveChoice = vi.fn(async () =>
      ok({
        choiceId,
        pokemonInstanceId,
        moveId,
        status: "SKIPPED" as const,
        replacedSlotNo: null,
        replayed: false,
      }),
    );
    const { service: subject } = service({ resolveMoveChoice });

    const result = await subject.resolve(identity, {
      choiceId,
      replaceSlotNo: null,
    });

    expect(result.ok).toBe(true);
    expect(resolveMoveChoice.mock.calls[0]?.[0]).toMatchObject({
      choiceId,
      playerId,
      replaceSlotNo: null,
    });
  });

  it("blocks changes during an active battle", async () => {
    const { service: subject, resolveMoveChoice } = service({ activeBattleId: "battle-1" });

    const result = await subject.resolve(identity, {
      choiceId,
      replaceSlotNo: 2,
    });

    expect(result.ok).toBe(false);
    expect(resolveMoveChoice).not.toHaveBeenCalled();
  });

  it("rejects a choice that is not owned by the authenticated player", async () => {
    const { service: subject, resolveMoveChoice } = service({ choices: [] });

    const result = await subject.resolve(identity, {
      choiceId,
      replaceSlotNo: 2,
    });

    expect(result.ok).toBe(false);
    expect(resolveMoveChoice).not.toHaveBeenCalled();
  });

  it("rejects a replacement slot that is not currently occupied", async () => {
    const { service: subject, resolveMoveChoice } = service();

    const result = await subject.resolve(identity, {
      choiceId,
      replaceSlotNo: 4,
    });

    expect(result.ok).toBe(false);
    expect(resolveMoveChoice).not.toHaveBeenCalled();
  });
});
