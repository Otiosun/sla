import { describe, expect, it } from "vitest";
import type { BattleRewardResult } from "../../src/modules/progression/contracts.js";
import { renderBattleRewardWhatsAppText } from "../../src/platform/progression/postgres-battle-reward-whatsapp-projector.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";
const POKEMON_ID = "00000000-0000-4000-8000-000000000025";
const FROM_FORM_ID = "00000000-0000-4000-8000-000000000035";
const TO_FORM_ID = "00000000-0000-4000-8000-000000000045";

function reward(): BattleRewardResult {
  return {
    battleId: "00000000-0000-4000-8000-000000000055",
    playerId: PLAYER_ID,
    pokemon: [
      {
        pokemonInstanceId: POKEMON_ID,
        offeredXp: 120,
        awardedXp: 120,
        discardedXp: 0,
        beforeLevel: 15,
        afterLevel: 16,
        beforeXp: 1000,
        afterXp: 1120,
        learnedMoveIds: [],
        pendingMoveChoiceIds: [],
        evolutions: [
          {
            pokemonInstanceId: POKEMON_ID,
            fromFormId: FROM_FORM_ID,
            toFormId: TO_FORM_ID,
            triggerKind: "LEVEL",
            beforeLevel: 15,
            afterLevel: 16,
            replayed: false,
          },
        ],
      },
    ],
    trainer: {
      playerId: PLAYER_ID,
      pointsGained: 10,
      beforePoints: 40,
      afterPoints: 50,
      beforeLevel: 1,
      afterLevel: 1,
      unlockKeys: [],
    },
    replayed: false,
  };
}

describe("battle reward WhatsApp evolution rendering", () => {
  it("names an automatic evolution without exposing form ids", () => {
    const output = renderBattleRewardWhatsAppText(
      reward(),
      "5511999999999@s.whatsapp.net",
      new Map([
        [FROM_FORM_ID, "Charmander"],
        [TO_FORM_ID, "Charmeleon"],
      ]),
    );

    expect(output).toContain("✨ Evolução: *Charmander* → *Charmeleon*.");
    expect(output).not.toContain(FROM_FORM_ID);
    expect(output).not.toContain(TO_FORM_ID);
  });

  it("falls back to a human message if display metadata is unavailable", () => {
    const output = renderBattleRewardWhatsAppText(reward(), "player:test");

    expect(output).toContain("✨ Uma evolução foi concluída.");
    expect(output).not.toContain("Evoluções aplicadas");
    expect(output).not.toContain(FROM_FORM_ID);
    expect(output).not.toContain(TO_FORM_ID);
  });
});
