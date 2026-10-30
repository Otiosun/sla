import { describe, expect, it } from "vitest";
import { renderExpeditionV4ActivePanel } from "../../src/modules/exploration/expedition-v4-active-panel.js";
import type { ExpeditionMenuChoice } from "../../src/modules/exploration/expedition-contextual-menu.js";

function currentChoices(): readonly ExpeditionMenuChoice[] {
  return [
    { optionNo: 1, intent: "SEARCH_FREE", label: "🔎 Buscar Pokémon", phrases: ["buscar"] },
    { optionNo: 2, intent: "SEARCH_RESOURCES", label: "🎒 Buscar recursos", phrases: [] },
    { optionNo: 3, intent: "TRAVEL", label: "🗺️ Viajar", phrases: [] },
    { optionNo: 4, intent: "END", label: "📋 Encerrar", phrases: [] },
  ];
}
const input = {
  phase: "ACTIVE" as const,
  period: "NIGHT" as const,
  currentTime: "20:15",
  elapsedMinutes: 135,
  choices: currentChoices(),
  combiningCount: 0,
};

describe("UX V4 ACTIVE Rotom shadow renderer", () => {
  it("preserves the approved compact header and server-presented actions", () => {
    const result = renderExpeditionV4ActivePanel(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.padded).toBe(false);
    expect(result.value.visible).toBe(
      "◇ *𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*\n🌙 *20:15*\n⌛ Restam `9h45`",
    );
    for (const text of [
      "1. 🔎 Buscar Pokémon", "2. 🎒 Buscar recursos",
      "3. 🗺️ Viajar", "4. 📋 Encerrar",
    ]) expect(result.value.text).toContain(text);
    expect(result.value.text).not.toContain("[Ler mais]");
  });

  it("uses only the calibrated U+031D spacer, never a fake editorial marker", () => {
    const result = renderExpeditionV4ActivePanel({ ...input, combiningCount: 450 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.padded).toBe(true);
    expect(result.value.text).toBe(
      result.value.visible + "\n\n" + "\u031d".repeat(450) + "\n\n" + result.value.expanded,
    );
  });

  it("retains full options if a caption limit cannot fit the spacer", () => {
    const result = renderExpeditionV4ActivePanel({
      ...input, combiningCount: 450, maxCodeUnits: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.padded).toBe(false);
    expect(result.value.text).toContain("4. 📋 Encerrar");
    expect(result.value.text).not.toContain("\u031d");
  });

  it("rejects duplicate, stale and unauthorized menu choices", () => {
    const invalid: readonly (readonly ExpeditionMenuChoice[])[] = [
      [{ ...currentChoices()[0]!, optionNo: 4 }, ...currentChoices().slice(1)],
      [{ optionNo: 6, intent: "CAPTURE", label: "Capturar", phrases: [] }],
      [{ optionNo: 0, intent: "END", label: "Encerrar", phrases: [] }],
      [],
    ];
    for (const choices of invalid) {
      expect(renderExpeditionV4ActivePanel({ ...input, choices }).ok).toBe(false);
    }
  });

  it("rejects invalid clock and elapsed minutes", () => {
    expect(renderExpeditionV4ActivePanel({ ...input, currentTime: "27:61" }).ok).toBe(false);
    expect(renderExpeditionV4ActivePanel({ ...input, elapsedMinutes: -1 }).ok).toBe(false);
    expect(renderExpeditionV4ActivePanel({ ...input, elapsedMinutes: 721 }).ok).toBe(false);
    expect(renderExpeditionV4ActivePanel({ ...input, elapsedMinutes: 0 }).ok).toBe(false);
    expect(renderExpeditionV4ActivePanel({ ...input, elapsedMinutes: 720 }).ok).toBe(false);
    expect(renderExpeditionV4ActivePanel({ ...input, currentTime: "21:15" }).ok).toBe(false);
    expect(renderExpeditionV4ActivePanel({ ...input, period: "DAY" }).ok).toBe(false);
  });
});
