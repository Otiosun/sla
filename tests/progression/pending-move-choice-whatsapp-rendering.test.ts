import { describe, expect, it } from "vitest";
import type { OperationalPendingMoveChoiceView } from "../../src/modules/messaging/operational-ux-read-model.js";
import { renderPendingMoveChoices } from "../../src/modules/progression/whatsapp-handlers.js";
import { createPokemonInstanceId } from "../../src/shared-kernel/ids.js";

const BASE: OperationalPendingMoveChoiceView = {
  choiceId: "00000000-0000-4000-8000-000000000099",
  pokemonInstanceId: createPokemonInstanceId(),
  pokemonDisplayName: "Eevee",
  learnLevel: 16,
  moveId: "00000000-0000-4000-8000-000000000010",
  moveDisplayName: "Golpe Novo",
  currentMoves: [
    {
      slotNo: 1,
      moveId: "00000000-0000-4000-8000-000000000010",
      displayName: "Golpe Novo",
    },
    {
      slotNo: 2,
      moveId: "00000000-0000-4000-8000-000000000020",
      displayName: "Outro Golpe",
    },
  ],
};

describe("pending move choice WhatsApp menu", () => {
  it("shows a helpful empty state", () => {
    expect(renderPendingMoveChoices([])).toContain("SEM PENDÊNCIAS");
  });

  it("marks an already-known offered move as skip only", () => {
    const message = renderPendingMoveChoices([BASE]);
    expect(message).toContain("_já conhece_ *Golpe Novo*");
    expect(message).toContain("Não substitua outro por ele");
    expect(message).toContain("`/aprender 1 pular`");
    expect(message).not.toContain("`/aprender 1 <1-4>`");
  });

  it("keeps slot replacement available for genuinely new moves", () => {
    const message = renderPendingMoveChoices([
      {
        ...BASE,
        moveId: "00000000-0000-4000-8000-000000000030",
        moveDisplayName: "Golpe Desconhecido",
      },
    ]);
    expect(message).toContain("_quer aprender_ *Golpe Desconhecido*");
    expect(message).toContain("`/aprender 1 <1-4>`");
    expect(message).toContain("`/aprender 1 pular`");
  });

  it("preserves individual option numbers across mixed pending choices", () => {
    const message = renderPendingMoveChoices([
      BASE,
      {
        ...BASE,
        choiceId: "00000000-0000-4000-8000-000000000098",
        moveId: "00000000-0000-4000-8000-000000000030",
      },
    ]);
    expect(message).toContain("`/aprender 1 pular`");
    expect(message).toContain("`/aprender 2 <1-4>`");
    expect(message).not.toContain("`/aprender 1 <1-4>`");
  });
});
