import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import type { ExpeditionSnapshot } from "../../src/modules/exploration/expedition-state.js";
import { ExpeditionRotomPreviewService } from "../../src/modules/exploration/expedition-rotom-preview.js";
import { renderExplorationRotomPreview } from "../../src/modules/exploration/expedition-rotom-presentation.js";
import type { WorldLocationView } from "../../src/modules/world/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const releaseId = "published-exploration-release";
const villageId = "area-village";
const yunId = "area-yun";
const now = new Date("2026-10-24T15:00:00Z");

function location(): WorldLocationView {
  return {
    playerId,
    contentReleaseId: releaseId,
    areaId: villageId,
    areaSlug: "vila-dos-arrozais",
    areaDisplayName: "Vila dos Arrozais",
    regionId: "zhoulia",
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    safePoint: true,
    revision: 0n,
    enteredAt: now,
    requiresRelocation: false,
    relocationAreaId: null,
    connections: [
      {
        connectionId: "village-to-yun",
        connectionKey: "village-yun",
        destinationAreaId: yunId,
        destinationSlug: "campos-de-yun",
        destinationDisplayName: "Campos de Yun",
        available: true,
        missingUnlockKeys: [],
      },
    ],
  };
}

function expedition(phase: "ACTIVE" | "PREPARING" = "ACTIVE"): ExpeditionSnapshot {
  return {
    expeditionId: "expedition-test",
    playerId,
    period: "DAY",
    areaId: villageId,
    currentAreaId: villageId,
    phase,
    elapsedMinutes: phase === "ACTIVE" ? 45 : 0,
    consumedWeekKey: phase === "ACTIVE" ? "2026-10-19" : null,
    endReason: null,
    revision: phase === "ACTIVE" ? 2n : 0n,
  };
}

function harness(
  state: ExpeditionSnapshot | null,
  usedThisWeek: number,
  current: WorldLocationView = location(),
) {
  const world = { getLocation: vi.fn().mockResolvedValue(ok(current)) };
  const published = {
    forActiveRelease: vi.fn().mockResolvedValue({
      contentReleaseId: releaseId,
      encounterReadyAreaIds: [villageId, yunId],
    }),
  };
  const facts = {
    read: vi.fn().mockResolvedValue({ expedition: state, usedThisWeek }),
  };
  const preview = new ExpeditionRotomPreviewService(
    world,
    published,
    facts,
    new ManualClock(now),
    "America/Maceio",
  );
  return { preview, world, published, facts };
}

describe("Rotom individual exploration read-only overview", () => {
  it("shows no active session, 3 weekly slots and only eligible published World connections", async () => {
    const { preview, facts } = harness(null, 0);
    const result = await preview.inspect(playerId);
    expect(result).toMatchObject({
      ok: true,
      value: {
        phase: "NONE",
        clock: null,
        usedThisWeek: 0,
        remainingThisWeek: 3,
        canPrepareUnderPolicy: true,
        canContinueUnderPolicy: false,
        destinations: ["Campos de Yun"],
        actionsEnabled: false,
      },
    });
    expect(facts.read).toHaveBeenCalledWith(playerId, "2026-10-19");
    if (result.ok) {
      const message = renderExplorationRotomPreview(result.value);
      expect(message).toContain("ROTOM · EXPLORAÇÃO");
      expect(message).toContain("Consulta gratuita");
      expect(message).toContain("não foram liberadas");
      expect(message).not.toContain("\n1. Viajar");
    }
  });

  it("shows a prepared session without spending the weekly slot or starting its clock", async () => {
    const result = await harness(expedition("PREPARING"), 0).preview.inspect(playerId);
    expect(result).toMatchObject({
      ok: true,
      value: {
        phase: "PREPARING",
        clock: { elapsedMinutes: 0, currentTime: "06:00", remainingMinutes: 720 },
        usedThisWeek: 0,
        remainingThisWeek: 3,
        actionsEnabled: false,
      },
    });
  });

  it("resumes on Yun with historical village origin and no extra weekly debit", async () => {
    const moved: WorldLocationView = {
      ...location(),
      areaId: yunId,
      areaSlug: "campos-de-yun",
      areaDisplayName: "Campos de Yun",
      revision: 1n,
      connections: [],
    };
    const saved = { ...expedition(), currentAreaId: yunId };
    const result = await harness(saved, 3, moved).preview.inspect(playerId);
    expect(result).toMatchObject({
      ok: true,
      value: {
        locationName: "Campos de Yun",
        phase: "ACTIVE",
        originMatchesCurrent: false,
        clock: { elapsedMinutes: 45, currentTime: "06:45", remainingMinutes: 675 },
        remainingThisWeek: 0,
        canContinueUnderPolicy: true,
        actionsEnabled: false,
      },
    });
    if (result.ok) {
      const message = renderExplorationRotomPreview(result.value);
      expect(message).toContain("Origem preservada no histórico");
      expect(message).toContain("0 restantes");
      expect(message).toContain("06:45");
    }
  });

  it("fails closed on a World cursor mismatch and never shows a misleading menu", async () => {
    const moved = { ...location(), areaId: yunId, areaSlug: "campos-de-yun" };
    expect(await harness(expedition(), 1, moved).preview.inspect(playerId)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("fails closed on missing published coverage and does not query expedition data", async () => {
    const h = harness(null, 0);
    h.published.forActiveRelease.mockResolvedValue(null);
    expect(await h.preview.inspect(playerId)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(h.facts.read).not.toHaveBeenCalled();
  });

  it("propagates World denial without probing expedition data", async () => {
    const h = harness(null, 0);
    h.world.getLocation.mockResolvedValue(err(appError("PLAYER_INELIGIBLE", "Inactive trainer")));
    expect(await h.preview.inspect(playerId)).toMatchObject({
      ok: false,
      error: { code: "PLAYER_INELIGIBLE" },
    });
    expect(h.published.forActiveRelease).not.toHaveBeenCalled();
    expect(h.facts.read).not.toHaveBeenCalled();
  });

  it("refuses inconsistent weekly counters instead of guessing a quota", async () => {
    expect(await harness(null, 4).preview.inspect(playerId)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("renders published place labels as single-line plain WhatsApp text", async () => {
    const current = { ...location(), areaDisplayName: "*Fake*\n1. /capturar" };
    const result = await harness(null, 0, current).preview.inspect(playerId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const message = renderExplorationRotomPreview(result.value);
      expect(message).toContain("Fake 1. /capturar");
      expect(message).not.toContain("*Fake*");
      expect(message).not.toContain("\n1. /capturar");
    }
  });
});
