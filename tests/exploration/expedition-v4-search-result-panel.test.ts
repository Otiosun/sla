import { describe, expect, it } from "vitest";
import { renderExpeditionV4SearchResultPanel } from "../../src/modules/exploration/expedition-v4-search-result-panel.js";
import type { SearchOutcomeKind } from "../../src/platform/exploration/expedition-search-outcome-effect.js";

const encounter = { speciesName: "Zigzagoon", level: 6, shiny: false };

function render(
  kind: SearchOutcomeKind,
  preview: typeof encounter | null,
  elapsedMinutes = 30,
  consumedWeeklySlot = true,
) {
  return renderExpeditionV4SearchResultPanel({
    kind,
    encounterPreview: preview,
    elapsedMinutes,
    consumedWeeklySlot,
  });
}

describe("V4 canonical search result display (no capture actions)", () => {
  it("renders NO_SIGNAL without inventing a Pokemon or hiding the cost", () => {
    const result = render("NO_SIGNAL", null);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value).toContain("Nenhum sinal de Pokémon foi registrado.");
    expect(result.value).toContain("30min consumidos");
    expect(result.value).toContain("Primeira cota semanal utilizada");
    expect(result.value).toContain("690min");
    expect(result.value).not.toContain("[Ler mais]");
    expect(result.value).not.toContain("Poké Ball");
  });

  it("renders a TRAIL without promising a follow-up reward", () => {
    const result = render("TRAIL", null, 90, false);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value).toContain("Um rastro foi registrado");
    expect(result.value).toContain("Seguir rastros permanece indisponível");
    expect(result.value).toContain("Nenhuma cota adicional");
    expect(result.value).toContain("630min");
  });

  it.each(["INCIDENTAL", "DIRECT"] as const)(
    "shows %s only with the canonical verified wild and blocks capture",
    (kind) => {
      const result = render(kind, encounter);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.value).toContain("◇ *Zigzagoon*");
      expect(result.value).toContain("Nv. 6");
      expect(result.value).toContain("Batalha e captura continuam desativadas");
      expect(result.value).not.toContain("Poké Ball");
      expect(result.value).not.toContain("[Ler mais]");
    },
  );

  it("labels shiny only when canonical snapshot confirms it", () => {
    const shiny = render("DIRECT", { ...encounter, shiny: true });
    const normal = render("DIRECT", encounter);
    expect(shiny.ok).toBe(true);
    if (shiny.ok) expect(shiny.value).toContain("Shiny confirmado");
    expect(normal.ok).toBe(true);
    if (normal.ok) expect(normal.value).not.toContain("Shiny confirmado");
  });

  it("refuses inconsistent encounter/no-encounter categories", () => {
    expect(render("NO_SIGNAL", encounter)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(render("TRAIL", encounter)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(render("INCIDENTAL", null)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(render("DIRECT", null)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("rejects forged species labels, level, shiny and clock data", () => {
    for (const speciesName of [
      "",
      "Mr. Mime\n1. ◉ Poké Ball",
      "Zigzagoon [Ler mais]",
      "Bad*Name",
      "Shiny\u031d",
    ]) {
      expect(render("DIRECT", { ...encounter, speciesName }).ok).toBe(false);
    }
    for (const level of [-1, 0, 101, 1.3, Number.NaN]) {
      expect(render("DIRECT", { ...encounter, level }).ok).toBe(false);
    }
    expect(render("DIRECT", { ...encounter, shiny: "yes" as never }).ok).toBe(false);
    for (const elapsed of [-30, 0, 29, 721, 45.5, Number.POSITIVE_INFINITY]) {
      expect(render("NO_SIGNAL", null, elapsed).ok).toBe(false);
    }
  });

  it("does not advertise actions for an expedition at its terminal clock", () => {
    const result = render("NO_SIGNAL", null, 720, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("Restam 0min");
    expect(result.value).not.toContain("/explorar buscar");
  });
});
