import { describe, expect, it } from "vitest";
import { capabilitiesForWorldGroupSetup } from "../../src/modules/community/world-group-setup.js";

describe("explicit /grupo jogo capabilities", () => {
  it("enables ordinary PVE/PVP play without granting narrator/admin permissions", () => {
    expect(capabilitiesForWorldGroupSetup("GAME", [])).toEqual([
      "player.basic",
      "pve",
      "pvp",
      "world",
    ]);
    expect(capabilitiesForWorldGroupSetup("GAME", ["pve", "observability"])).toEqual([
      "observability",
      "player.basic",
      "pve",
      "pvp",
      "world",
    ]);
    expect(capabilitiesForWorldGroupSetup("GAME", [])).not.toContain("admin");
  });

  it("keeps reception isolated even if it previously had gameplay permissions", () => {
    expect(capabilitiesForWorldGroupSetup("RECEPTION", ["pve", "pvp", "world"])).toEqual([
      "admin.review",
      "onboarding",
    ]);
  });

  it("does not silently enable combat in COMMUNITY, STAFF or PVP roles", () => {
    expect(capabilitiesForWorldGroupSetup("COMMUNITY", [])).toEqual([
      "player.basic",
      "world",
    ]);
    expect(capabilitiesForWorldGroupSetup("STAFF", [])).toEqual([
      "player.basic",
      "world",
    ]);
    expect(capabilitiesForWorldGroupSetup("PVP", ["pvp"])).toEqual([
      "player.basic",
      "pvp",
      "world",
    ]);
  });
});
