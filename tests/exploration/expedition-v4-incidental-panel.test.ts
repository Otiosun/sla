import { describe, expect, it } from "vitest";
import {
  renderExpeditionV4IncidentalPanel,
  selectCurrentIncidentalAction,
  type IncidentalEncounterPanelInput,
} from "../../src/modules/exploration/expedition-v4-incidental-panel.js";

const current: IncidentalEncounterPanelInput = {
  source: "INCIDENTAL",
  encounterStatus: "PRESENTED",
  encounterId: "e4c48e48-35d5-4fd7-9fee-d69ce4cfa50e",
  encounterRevision: 7n,
  speciesName: "Zigzagoon",
  level: 6,
  canBattle: true,
  balls: [
    { kind: "ULTRA", quantity: 1, captureAuthorized: true },
    { kind: "POKE", quantity: 3, captureAuthorized: true },
    { kind: "GREAT", quantity: 1, captureAuthorized: true },
  ],
  canIgnore: true,
  ignoreMinutes: 10,
  combiningCount: 450,
};

describe("incidental V4 shadow scene: canonically authorized actions only", () => {
  it("preserves V4 battle/capture hierarchy, real stocks and fixed option numbers", () => {
    const shown = renderExpeditionV4IncidentalPanel(current);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value.visible).toContain("✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢*");
    expect(shown.value.visible).toContain("◇ *Zigzagoon* ● `Nv. 6`");
    expect(shown.value.expanded).toContain("◇ *𝗔ÇÕ𝗘𝗦*");
    expect(shown.value.expanded).toContain("◇ *𝗖𝗔𝗣𝗧𝗨𝗥𝗔𝗥*");
    const names = ["1. ⚔️ Batalhar", "2. ◉ Poké Ball ● `×3`",
      "3. ◈ Great Ball ● `×1`", "4. ✧ Ultra Ball ● `×1`",
      "0. ↩️ Ignorar ● `10 min`"];
    let last = -1;
    for (const name of names) {
      const next = shown.value.expanded.indexOf(name);
      expect(next).toBeGreaterThan(last);
      last = next;
    }
    expect(shown.value.choices.map(x => x.optionNo)).toEqual([1, 2, 3, 4, 0]);
    expect(shown.value.text).toContain("\u031d".repeat(450));
    expect(shown.value.text).not.toContain("[Ler mais]");
  });

  it("omits empty or unauthorized Balls without renumbering another Ball", () => {
    const shown = renderExpeditionV4IncidentalPanel({
      ...current, balls: [
        { kind: "POKE", quantity: 0, captureAuthorized: true },
        { kind: "GREAT", quantity: 2, captureAuthorized: true },
        { kind: "ULTRA", quantity: 9, captureAuthorized: false },
      ],
    });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value.choices.map(x => x.optionNo)).toEqual([1, 3, 0]);
    expect(shown.value.expanded).toContain("3. ◈ Great Ball ● `×2`");
    expect(shown.value.expanded).not.toContain("Poké Ball");
    expect(shown.value.expanded).not.toContain("Ultra Ball");
    expect(selectCurrentIncidentalAction({
      raw: "2", menu: shown.value, expectedEncounterRevision: 7n, expectedEncounterId: current.encounterId,
    })).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(selectCurrentIncidentalAction({
      raw: "3", menu: shown.value, expectedEncounterRevision: 7n, expectedEncounterId: current.encounterId,
    })).toMatchObject({ ok: true, value: { optionNo: 3, kind: "CAPTURE", ball: "GREAT" } });
    expect(selectCurrentIncidentalAction({
      raw: "0", menu: shown.value, expectedEncounterRevision: 7n, expectedEncounterId: current.encounterId,
    })).toMatchObject({ ok: true, value: { kind: "IGNORE", optionNo: 0 } });
  });

  it("refuses stale menus, ambiguity, missing actions and invalid inventory", () => {
    const shown = renderExpeditionV4IncidentalPanel(current);
    if (!shown.ok) throw new Error("Test fixture must render");
    expect(selectCurrentIncidentalAction({
      raw: "2", menu: shown.value, expectedEncounterRevision: 8n, expectedEncounterId: current.encounterId,
    })).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    expect(selectCurrentIncidentalAction({
      raw: "2", menu: shown.value, expectedEncounterRevision: 7n,
      expectedEncounterId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    for (const raw of ["23", "2 3", "/capturar", "Pokebola", "", "5"]) {
      expect(selectCurrentIncidentalAction({
        raw, menu: shown.value, expectedEncounterRevision: 7n, expectedEncounterId: current.encounterId,
      }).ok).toBe(false);
    }
    expect(renderExpeditionV4IncidentalPanel({
      ...current, canBattle: false, canIgnore: false, balls: [],
    })).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(renderExpeditionV4IncidentalPanel({
      ...current, balls: [...current.balls, current.balls[0]!],
    }).ok).toBe(false);
    expect(renderExpeditionV4IncidentalPanel({
      ...current, balls: [{ kind: "POKE", quantity: -1, captureAuthorized: true }],
    }).ok).toBe(false);
  });

  it("rejects fabricated species names and unsafe game-state data", () => {
    expect(renderExpeditionV4IncidentalPanel({
      ...current, speciesName: "Zigzagoon\\n/[Ler mais]",
    }).ok).toBe(false);
    expect(renderExpeditionV4IncidentalPanel({
      ...current, speciesName: "*Zigzagoon*",
    }).ok).toBe(false);
    expect(renderExpeditionV4IncidentalPanel({
      ...current, level: 0,
    }).ok).toBe(false);
    expect(renderExpeditionV4IncidentalPanel({
      ...current, encounterStatus: "CREATED" as "PRESENTED",
    }).ok).toBe(false);
    expect(renderExpeditionV4IncidentalPanel({
      ...current, ignoreMinutes: 99 as 10,
    }).ok).toBe(false);
  });

  it("uses complete accessible fallback when U+031D or captions cannot fit", () => {
    for (const fold of [
      { combiningCount: 0 },
      { combiningCount: 450, maxCodeUnits: 140 },
    ]) {
      const shown = renderExpeditionV4IncidentalPanel({ ...current, ...fold });
      expect(shown.ok).toBe(true);
      if (!shown.ok) continue;
      expect(shown.value.padded).toBe(false);
      expect(shown.value.text).toBe(shown.value.visible + "\n\n" + shown.value.expanded);
      expect(shown.value.text).not.toContain("\u031d");
      expect(shown.value.text).toContain("0. ↩️ Ignorar");
    }
  });
});
