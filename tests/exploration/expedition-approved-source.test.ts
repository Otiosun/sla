import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExpeditionMenuChoice } from "../../src/modules/exploration/expedition-contextual-menu.js";
import { renderExpeditionV4ActivePanel } from "../../src/modules/exploration/expedition-v4-active-panel.js";
import { renderExpeditionV4IncidentalPanel } from "../../src/modules/exploration/expedition-v4-incidental-panel.js";
import {
  renderExpeditionV4OpeningPanel,
  renderExpeditionV4PreparingPanel,
} from "../../src/modules/exploration/expedition-v4-preparation-panel.js";

// Independent product source, never generated from the renderer under test.
const original = readFileSync(
  new URL(
    "../../docs/ux/canonical/originals/EXPLORATION_PLAYER_FLOW_UX_V4_APPROVED_20261026.md",
    import.meta.url,
  ),
  "utf8",
);
const panels = [...original.matchAll(/```text\n([\s\S]*?)\n```/gu)].map((match) => match[1]!);
const choice = (
  optionNo: number,
  intent: ExpeditionMenuChoice["intent"],
  label: string,
): ExpeditionMenuChoice => ({ optionNo, intent, label, phrases: [] });

describe("V4 complete strings versus immutable approved source", () => {
  it("preserves opening, with only the explicit 04/11 weekly override", () => {
    const result = renderExpeditionV4OpeningPanel({
      phase: "NONE",
      locationName: "Campos de Yun",
      remainingThisWeek: 6,
      canPrepareUnderPolicy: true,
      choices: [choice(1, "PREPARE_DAY", "Diurno"), choice(2, "PREPARE_NIGHT", "Noturno")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(panels[0]!.replace("Disponíveis:* 3/3", "Disponíveis:* 6/6"));
    expect(result.value.padded).toBe(false);
  });
  it("preserves preparation, formatting, all actions and fold boundary", () => {
    const result = renderExpeditionV4PreparingPanel({
      expedition: {
        expeditionId: "synthetic",
        playerId: "synthetic",
        areaId: "synthetic",
        period: "NIGHT",
        phase: "PREPARING",
        elapsedMinutes: 0,
        consumedWeekKey: null,
        endReason: null,
        revision: 0n,
      },
      locationName: "Campos de Yun",
      remainingThisWeek: 6,
      combiningCount: 450,
      choices: [
        choice(1, "SEARCH_FREE", "🔎 Buscar Pokémon ● 30 min"),
        choice(2, "SEARCH_RESOURCES", "🎒 Buscar recursos ● 60 min"),
        choice(3, "DESTINATIONS", "🗺️ Consultar destinos"),
        choice(4, "CHANGE_PERIOD", "🔄 Alterar período"),
        choice(5, "CANCEL_PREPARATION", "↩️ Cancelar preparação"),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.visible + "\n\n[Ler mais]\n\n" + result.value.expanded).toBe(panels[1]);
    expect(result.value.text).toBe(panels[1]!.replace("[Ler mais]", "\u031d".repeat(450)));
  });
  it("preserves active panel, clock, action order and fold boundary", () => {
    const result = renderExpeditionV4ActivePanel({
      phase: "ACTIVE",
      period: "NIGHT",
      currentTime: "20:15",
      elapsedMinutes: 135,
      combiningCount: 450,
      choices: [
        choice(1, "SEARCH_FREE", "🔎 Buscar Pokémon"),
        choice(2, "SEARCH_RESOURCES", "🎒 Buscar recursos"),
        choice(3, "TRAVEL", "🗺️ Viajar"),
        choice(4, "END", "📋 Encerrar"),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(panels[2]!.replace("[Ler mais]", "\u031d".repeat(450)));
  });
  it("preserves incidental copy, symbols, stocks, numbers and hierarchy", () => {
    const result = renderExpeditionV4IncidentalPanel({
      source: "INCIDENTAL",
      encounterStatus: "ENGAGED",
      encounterId: "e4c48e48-35d5-4fd7-9fee-d69ce4cfa50e",
      encounterRevision: 1n,
      speciesName: "Zigzagoon",
      level: 6,
      canBattle: true,
      canIgnore: true,
      ignoreMinutes: 10,
      combiningCount: 450,
      balls: [
        { kind: "POKE", quantity: 3, captureAuthorized: true },
        { kind: "GREAT", quantity: 1, captureAuthorized: true },
        { kind: "ULTRA", quantity: 1, captureAuthorized: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(panels[3]!.replace("[Ler mais]", "\u031d".repeat(450)));
  });
});
