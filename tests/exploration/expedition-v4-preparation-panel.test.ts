import { describe, expect, it } from "vitest";
import {
  renderExpeditionV4OpeningPanel,
  renderExpeditionV4PreparingPanel,
} from "../../src/modules/exploration/expedition-v4-preparation-panel.js";
import {
  selectExpeditionMenuChoice,
  type ExpeditionMenuChoice,
} from "../../src/modules/exploration/expedition-contextual-menu.js";
import type { ExpeditionSnapshot } from "../../src/modules/exploration/expedition-state.js";

const periods: readonly ExpeditionMenuChoice[] = [
  { optionNo: 1, intent: "PREPARE_DAY", label: "Diurno", phrases: ["diurno"] },
  { optionNo: 2, intent: "PREPARE_NIGHT", label: "Noturno", phrases: ["noturno"] },
];
const preparingActions: readonly ExpeditionMenuChoice[] = [
  {
    optionNo: 1,
    intent: "SEARCH_FREE",
    label: "🔎 Buscar Pokémon ● `30 min`",
    phrases: ["buscar"],
  },
  {
    optionNo: 2,
    intent: "SEARCH_RESOURCES",
    label: "🎒 Buscar recursos ● `60 min`",
    phrases: ["recursos"],
  },
  { optionNo: 3, intent: "DESTINATIONS", label: "🗺️ Consultar destinos", phrases: ["destinos"] },
  { optionNo: 4, intent: "CHANGE_PERIOD", label: "🔄 Alterar período", phrases: ["alterar"] },
  {
    optionNo: 5,
    intent: "CANCEL_PREPARATION",
    label: "↩️ Cancelar preparação",
    phrases: ["cancelar"],
  },
];
const expedition: ExpeditionSnapshot = {
  expeditionId: "synthetic-preparation",
  playerId: "synthetic-player",
  areaId: "synthetic-area",
  period: "NIGHT",
  phase: "PREPARING",
  elapsedMinutes: 0,
  consumedWeekKey: null,
  endReason: null,
  revision: 7n,
};

describe("Exploration V4 opening and PREPARING shadow contract", () => {
  it("renders the literal approved opening without any fold, resource spending or mutation", () => {
    const result = renderExpeditionV4OpeningPanel({
      phase: "NONE",
      locationName: "Campos de Yun",
      remainingThisWeek: 3,
      canPrepareUnderPolicy: true,
      choices: periods,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ padded: false, expanded: "" });
    expect(result.value.text).toContain("✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*");
    expect(result.value.text).toContain("*⌖ Local:* Campos de Yun");
    expect(result.value.text).toContain("*🎟️ Disponíveis:* 3/3");
    expect(result.value.text).toContain("1. ☀️ *Diurno*");
    expect(result.value.text).toContain("2. 🌙 *Noturno*");
    expect(result.value.text).not.toContain("\u031d");
    expect(result.value.text).not.toContain("[Ler mais]");
  });

  it("does not offer a new expedition when all slots are used or period is unauthorized", () => {
    const valid = {
      phase: "NONE" as const,
      locationName: "Campos de Yun",
      remainingThisWeek: 3,
      canPrepareUnderPolicy: true as const,
      choices: periods,
    };
    expect(renderExpeditionV4OpeningPanel({ ...valid, remainingThisWeek: 0 }).ok).toBe(false);
    expect(renderExpeditionV4OpeningPanel({ ...valid, choices: periods.slice(0, 1) }).ok).toBe(
      false,
    );
    expect(
      renderExpeditionV4OpeningPanel({
        ...valid,
        choices: [{ ...periods[1]!, optionNo: 1 }, periods[0]!],
      }).ok,
    ).toBe(false);
    expect(
      renderExpeditionV4OpeningPanel({
        ...valid,
        locationName: "`[Ler mais]`",
      }).ok,
    ).toBe(false);
  });

  it("renders the PREPARING state with the exact 12h clock and quota unconsumed", () => {
    const result = renderExpeditionV4PreparingPanel({
      expedition,
      locationName: "Campos de Yun",
      remainingThisWeek: 3,
      combiningCount: 450,
      choices: preparingActions,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.visible).toContain("🌙 `18:00 → 06:00`");
    expect(result.value.visible).toContain("*⌛ 12h* disponíveis");
    expect(result.value.visible).toContain("*🎟️ Cota ainda não consumida*");
    expect(result.value.expanded).toContain("1. 🔎 Buscar Pokémon ● 30 min");
    expect(result.value.expanded).toContain("2. 🎒 Buscar recursos ● 60 min");
    expect(result.value.expanded).toContain("5. ↩️ Cancelar preparação");
    expect(result.value.text).toBe(
      result.value.visible + "\n\n" + "\u031d".repeat(450) + "\n\n" + result.value.expanded,
    );
    expect(result.value.text).not.toContain("[Ler mais]");
    expect(expedition).toMatchObject({ elapsedMinutes: 0, consumedWeekKey: null, revision: 7n });
  });

  it("retains all current options with uncalibrated or too-large fold on text/caption", () => {
    const common = {
      expedition,
      locationName: "Campos de Yun",
      remainingThisWeek: 2,
      choices: preparingActions,
    };
    for (const input of [
      { ...common, combiningCount: 0 },
      { ...common, combiningCount: 450, maxCodeUnits: 120 },
    ]) {
      const result = renderExpeditionV4PreparingPanel(input);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.padded).toBe(false);
      expect(result.value.text).toContain("5. ↩️ Cancelar preparação");
      expect(result.value.text).not.toContain("\u031d");
    }
  });

  it("refuses ACTIVE, consumed quota, invalid location and unauthorized menu intents", () => {
    const common = {
      expedition,
      locationName: "Campos de Yun",
      remainingThisWeek: 3,
      combiningCount: 0,
      choices: preparingActions,
    };
    expect(
      renderExpeditionV4PreparingPanel({
        ...common,
        expedition: { ...expedition, phase: "ACTIVE" },
      }).ok,
    ).toBe(false);
    expect(
      renderExpeditionV4PreparingPanel({
        ...common,
        expedition: { ...expedition, elapsedMinutes: 30 },
      }).ok,
    ).toBe(false);
    expect(
      renderExpeditionV4PreparingPanel({
        ...common,
        expedition: {
          ...expedition,
          consumedWeekKey: "2026-10-26",
        },
      }).ok,
    ).toBe(false);
    expect(
      renderExpeditionV4PreparingPanel({
        ...common,
        choices: [{ optionNo: 6, intent: "CAPTURE", label: "Poké Ball", phrases: [] }],
      }).ok,
    ).toBe(false);
    expect(
      renderExpeditionV4PreparingPanel({
        ...common,
        choices: [preparingActions[0]!, { ...preparingActions[1]!, optionNo: 1 }],
      }).ok,
    ).toBe(false);
  });

  it("requires server authorization for preparing, changing period, cancelling and spending time", () => {
    for (const choice of [...periods, ...preparingActions]) {
      const result = selectExpeditionMenuChoice({
        text: String(choice.optionNo),
        choices: periods.includes(choice) ? periods : preparingActions,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const isReadOnly = choice.intent === "DESTINATIONS";
      expect(result.value.requiresServerActionAuthorization).toBe(!isReadOnly);
    }
  });
});
