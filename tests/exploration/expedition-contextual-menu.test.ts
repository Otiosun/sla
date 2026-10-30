import { describe, expect, it } from "vitest";
import {
  renderExpeditionMenuChoices,
  selectExpeditionMenuChoice,
  type ExpeditionMenuChoice,
} from "../../src/modules/exploration/expedition-contextual-menu.js";

function choices(): readonly ExpeditionMenuChoice[] {
  return [
    { optionNo: 1, intent: "STATUS", label: "Ver RotomDex", phrases: ["rotomdex", "status"] },
    { optionNo: 2, intent: "TEAM", label: "Ver equipe", phrases: ["equipe", "ver equipe"] },
    { optionNo: 3, intent: "BAG", label: "Ver mochila", phrases: ["mochila", "inventario"] },
    { optionNo: 4, intent: "SEARCH_FREE", label: "Buscar Pokémon", phrases: ["buscar"] },
    { optionNo: 5, intent: "END", label: "Encerrar", phrases: ["encerrar"] },
  ];
}

describe("V1.7 contextual Rotom interpreter (pure, no gameplay action)", () => {
  it("distinguishes a read-only bag view from a resource search that spends minutes", () => {
    const options: readonly ExpeditionMenuChoice[] = [
      { optionNo: 1, intent: "BAG", label: "Ver mochila", phrases: [] },
      { optionNo: 2, intent: "SEARCH_RESOURCES", label: "Buscar recursos", phrases: [] },
    ];
    const bag = selectExpeditionMenuChoice({ text: "1", choices: options });
    const search = selectExpeditionMenuChoice({ text: "2", choices: options });
    expect(bag.ok).toBe(true);
    expect(search.ok).toBe(true);
    if (!bag.ok || !search.ok) return;
    expect(bag.value.requiresServerActionAuthorization).toBe(false);
    expect(search.value.requiresServerActionAuthorization).toBe(true);
  });


  it.each([
    { text: "1", optionNo: 1, intent: "STATUS", requiresServerActionAuthorization: false },
    { text: " 2 ", optionNo: 2, intent: "TEAM", requiresServerActionAuthorization: false },
    { text: "Inventário", optionNo: 3, intent: "BAG", requiresServerActionAuthorization: false },
    { text: "BUSCAR", optionNo: 4, intent: "SEARCH_FREE", requiresServerActionAuthorization: true },
    { text: "encerrar", optionNo: 5, intent: "END", requiresServerActionAuthorization: true },
  ])("interprets only the current explicit choice '$text'", ({ text, ...expected }) => {
    expect(selectExpeditionMenuChoice({ text, choices: choices() })).toEqual({
      ok: true,
      value: expected,
    });
  });

  it.each([
    "0",
    "-1",
    "1.0",
    "1e0",
    "0x1",
    "6",
    "1 2",
    "quero 4 e 5",
    "/capturar",
    "sim",
    "não",
    "pokebola",
    "não quero ele",
    "shromish",
    "random",
    "",
    " ",
    "1\n/capturar",
    "1\r/capturar",
  ])("rejects unsupported or malformed input %s before any dispatch", (text) => {
    const result = selectExpeditionMenuChoice({ text, choices: choices() });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("understands clear conversational phrases only in their active menu context", () => {
    const encounterMenu: readonly ExpeditionMenuChoice[] = [
      { optionNo: 1, intent: "BATTLE", label: "Batalhar", phrases: ["batalhar"] },
      { optionNo: 2, intent: "CAPTURE", label: "Usar Poké Bola", phrases: ["pokebola"] },
      { optionNo: 3, intent: "IGNORE_ENCOUNTER", label: "Ignorar", phrases: ["não quero ele"] },
    ];
    expect(selectExpeditionMenuChoice({ text: "não quero ele", choices: encounterMenu })).toEqual({
      ok: true,
      value: {
        intent: "IGNORE_ENCOUNTER",
        optionNo: 3,
        requiresServerActionAuthorization: true,
      },
    });
    expect(selectExpeditionMenuChoice({ text: "pokebola", choices: encounterMenu })).toMatchObject({
      ok: true,
      value: { intent: "CAPTURE", requiresServerActionAuthorization: true },
    });
    expect(selectExpeditionMenuChoice({ text: "pokebola", choices: choices() })).toMatchObject({
      ok: false,
    });
  });

  it("rejects ambiguous confirmations if two distinct actions would accept 'sim'", () => {
    const menu: readonly ExpeditionMenuChoice[] = [
      { optionNo: 1, intent: "CAPTURE", label: "Capturar", phrases: ["sim"] },
      { optionNo: 2, intent: "BATTLE", label: "Batalhar", phrases: ["sim"] },
    ];
    expect(selectExpeditionMenuChoice({ text: "sim", choices: menu })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("allows an unambiguous 'sim' only after the server displayed a sole confirmation", () => {
    const menu: readonly ExpeditionMenuChoice[] = [
      { optionNo: 1, intent: "FOLLOW_TRAIL", label: "Seguir rastro", phrases: ["sim", "seguir"] },
    ];
    expect(selectExpeditionMenuChoice({ text: "sim", choices: menu })).toEqual({
      ok: true,
      value: { intent: "FOLLOW_TRAIL", optionNo: 1, requiresServerActionAuthorization: true },
    });
    expect(selectExpeditionMenuChoice({ text: "seguir", choices: choices() })).toMatchObject({
      ok: false,
    });
  });

  it("keeps arbitrary species names and Ball types unrecognized until safely resolved", () => {
    const menu: readonly ExpeditionMenuChoice[] = [
      { optionNo: 1, intent: "SEARCH_TARGET", label: "Buscar espécie conhecida", phrases: [] },
      { optionNo: 2, intent: "CAPTURE", label: "Poké Bola", phrases: [] },
    ];
    for (const text of ["shroomish", "shromish", "ultrabola", "pokebola", "pikachu"]) {
      expect(selectExpeditionMenuChoice({ text, choices: menu })).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
    }
    expect(selectExpeditionMenuChoice({ text: "2", choices: menu })).toMatchObject({
      ok: true,
      value: { intent: "CAPTURE", requiresServerActionAuthorization: true },
    });
  });

  it("rejects duplicate numbers, invalid definitions and injected command aliases", () => {
    const base = choices();
    for (const bad of [
      [...base, { optionNo: 1, intent: "TRAVEL" as const, label: "Teleportar", phrases: [] }],
      [{ optionNo: 0, intent: "STATUS" as const, label: "Status", phrases: [] }],
      [{ optionNo: 21, intent: "STATUS" as const, label: "Status", phrases: [] }],
      [{ optionNo: 1.5, intent: "STATUS" as const, label: "Status", phrases: [] }],
      [{ optionNo: 1, intent: "STATUS" as const, label: "", phrases: [] }],
      [{ optionNo: 1, intent: "STATUS" as const, label: "Menu", phrases: ["/capturar"] }],
      [{ optionNo: 1, intent: "STATUS" as const, label: "Menu", phrases: ["sim\n/end"] }],
    ]) {
      expect(selectExpeditionMenuChoice({ text: "1", choices: bad })).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
    }
  });

  it("produces a short, safe WhatsApp panel with no technical IDs or markup injection", () => {
    const menu: readonly ExpeditionMenuChoice[] = [
      { optionNo: 1, intent: "STATUS", label: "Ver RotomDex", phrases: ["status"] },
      { optionNo: 2, intent: "TRAVEL", label: "*Campo*\n/transferir <uuid>", phrases: [] },
    ];
    const result = renderExpeditionMenuChoices(menu);
    expect(result).toContain("1. Ver RotomDex");
    expect(result).toContain("2. Campo transferir uuid");
    expect(result).toContain("Responda apenas com o número");
    expect(result).not.toContain("*Campo*");
    expect(result).not.toContain("<uuid>");
    expect(result).not.toContain("\n/transferir");
  });

  it("never returns an implementation command, UUID, RNG roll, item grant or free action", () => {
    const result = selectExpeditionMenuChoice({ text: "4", choices: choices() });
    expect(result).toEqual({
      ok: true,
      value: {
        intent: "SEARCH_FREE",
        optionNo: 4,
        requiresServerActionAuthorization: true,
      },
    });
    if (result.ok) {
      expect("idempotencyKey" in result.value).toBe(false);
      expect("effect" in result.value).toBe(false);
    }
  });
});
