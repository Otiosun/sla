import { describe, expect, it } from "vitest";
import { renderExpeditionV4EventHistoryPanel } from "../../src/modules/exploration/expedition-v4-event-history-panel.js";

const basic = {
  period: "DAY" as const,
  endReason: "VOLUNTARY" as const,
  elapsedMinutes: 90,
  page: 1,
  pages: 2,
  totalEvents: 13,
  events: [
    {
      kind: "RESOURCES" as const,
      occurredAt: new Date("2026-11-02T10:00:00Z"),
      elapsedMinutes: 90,
      description: "Recursos: Poké Ball ×2",
      receiptRef: "immutable-receipt",
    },
  ],
};

describe("V4 factual event history Rotom presentation", () => {
  it("paginates trusted events without inventing captures, battles, coins or fold markers", () => {
    const panel = renderExpeditionV4EventHistoryPanel(basic);
    expect(panel).toMatchObject({ ok: true });
    if (!panel.ok) return;
    expect(panel.value).toContain("Recursos: Poké Ball ×2");
    expect(panel.value).toContain("/explorar eventos 2");
    expect(panel.value).toContain("Página 1/2");
    expect(panel.value).not.toContain("[Ler mais]");
    expect(panel.value).not.toContain("immutable-receipt");
    expect(panel.value).not.toContain("Vitória confirmada");
  });
  it("rejects unsupported pages and forged formatted event descriptions", () => {
    expect(renderExpeditionV4EventHistoryPanel({ ...basic, page: 3 })).toMatchObject({
      ok: false,
    });
    expect(renderExpeditionV4EventHistoryPanel({
      ...basic,
      events: [{ ...basic.events[0]!, description: "Poké Ball\n*Admin reward*" }],
    })).toMatchObject({ ok: false });
  });
});
