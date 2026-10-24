import { describe, expect, it, vi } from "vitest";
import { ExpeditionWorldPreview } from "../../src/modules/exploration/expedition-world-preview.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";
import type { WorldLocationView } from "../../src/modules/world/contracts.js";

const playerId = createPlayerId();
const releaseId = "published-release";
const areaId = "vila-id";

function location(): WorldLocationView {
  return {
    playerId,
    contentReleaseId: releaseId,
    areaId,
    areaSlug: "vila-dos-arrozais",
    areaDisplayName: "Vila dos Arrozais",
    regionId: "zhoulia-id",
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    safePoint: true,
    revision: 0n,
    enteredAt: new Date("2026-10-24T12:00:00Z"),
    requiresRelocation: false,
    relocationAreaId: null,
    connections: [],
  };
}

describe("exploration World preview composition", () => {
  it("reads World first and authorizes only matching published content", async () => {
    const getLocation = vi.fn().mockResolvedValue(ok(location()));
    const forActiveRelease = vi.fn().mockResolvedValue({
      contentReleaseId: releaseId,
      encounterReadyAreaIds: [areaId],
    });
    const preview = new ExpeditionWorldPreview({ getLocation }, { forActiveRelease });
    expect(await preview.inspect(playerId)).toMatchObject({
      ok: true,
      value: { currentAreaId: areaId, availableDestinations: [] },
    });
    expect(getLocation).toHaveBeenCalledWith(playerId);
    expect(forActiveRelease).toHaveBeenCalledWith(releaseId);
  });

  it("fails closed when there is no published encounter coverage", async () => {
    const getLocation = vi.fn().mockResolvedValue(ok(location()));
    const forActiveRelease = vi.fn().mockResolvedValue(null);
    const preview = new ExpeditionWorldPreview({ getLocation }, { forActiveRelease });
    expect(await preview.inspect(playerId)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("does not query catalog if World denies the player", async () => {
    const getLocation = vi.fn().mockResolvedValue(
      err(appError("PLAYER_INELIGIBLE", "Player cannot read their current World location")),
    );
    const forActiveRelease = vi.fn();
    const preview = new ExpeditionWorldPreview({ getLocation }, { forActiveRelease });
    expect(await preview.inspect(playerId)).toMatchObject({
      ok: false,
      error: { code: "PLAYER_INELIGIBLE" },
    });
    expect(forActiveRelease).not.toHaveBeenCalled();
  });
});
