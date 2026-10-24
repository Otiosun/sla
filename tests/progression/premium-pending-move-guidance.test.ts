import { describe, expect, it } from "vitest";
import type { OperationalPendingMoveChoiceView } from "../../src/modules/messaging/operational-ux-read-model.js";
import { renderPendingMoveChoices } from "../../src/modules/progression/whatsapp-handlers.js";
import { createPokemonInstanceId } from "../../src/shared-kernel/ids.js";

const choice: OperationalPendingMoveChoiceView = {
  choiceId: "00000000-0000-4000-8000-000000000099",
  pokemonInstanceId: createPokemonInstanceId(),
  pokemonDisplayName: "Eevee",
  learnLevel: 16,
  moveId: "00000000-0000-4000-8000-000000000010",
  moveDisplayName: "Golpe Novo",
  currentMoves: [
    { slotNo: 1, moveId: "00000000-0000-4000-8000-000000000010", displayName: "Golpe Novo" },
    { slotNo: 2, moveId: "00000000-0000-4000-8000-000000000020", displayName: "Outro Golpe" },
  ],
};

describe("Premium pending move guidance", () => {
  it("does not invite an already-known move to overwrite another", () => {
    const text = renderPendingMoveChoices([choice]);
    expect(text).toContain("já conhece");
    expect(text).toContain("/aprender 1 pular");
    expect(text).not.toContain("/aprender 1 <1-4>");
  });
  it("offers replacement slots for a new move", () => {
    const text = renderPendingMoveChoices([
      { ...choice, moveId: "00000000-0000-4000-8000-000000000030" },
    ]);
    expect(text).toContain("/aprender 1 <1-4>");
  });
});
