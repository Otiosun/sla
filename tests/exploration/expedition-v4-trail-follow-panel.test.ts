import { describe, expect, it } from "vitest";
import { renderExpeditionV4TrailFollowPanel } from "../../src/modules/exploration/expedition-v4-trail-follow-panel.js";

describe("V4 TRAIL follow is factual and safe", () => {
  it("shows only canonical species, real 15-minute cost, remaining clock and no new weekly slot", () => {
    const panel = renderExpeditionV4TrailFollowPanel({
      encounterPreview: { speciesName: "Published Testmon", level: 4, shiny: false },
      elapsedMinutes: 45,
      consumedWeeklySlot: false,
    });
    expect(panel).toMatchObject({ ok: true });
    if (!panel.ok) return;
    expect(panel.value).toContain("Published Testmon");
    expect(panel.value).toContain("15 min");
    expect(panel.value).toContain("675min");
    expect(panel.value).not.toContain("[Ler mais]");
    expect(panel.value).not.toContain("Shiny confirmado");
  });

  it("rejects unverified species and a second quota as unsafe to show", () => {
    for (const preview of [
      { speciesName: "Fake\nitem", level: 5, shiny: false },
      { speciesName: "Fake", level: -1, shiny: false },
      { speciesName: "Fake", level: 5, shiny: "false" },
    ]) {
      expect(
        renderExpeditionV4TrailFollowPanel({
          encounterPreview: preview as { speciesName: string; level: number; shiny: boolean },
          elapsedMinutes: 45,
          consumedWeeklySlot: false,
        }),
      ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    }
    expect(
      renderExpeditionV4TrailFollowPanel({
        encounterPreview: { speciesName: "Published Testmon", level: 4, shiny: false },
        elapsedMinutes: 45,
        consumedWeeklySlot: true,
      }),
    ).toMatchObject({ ok: false });
  });
});
