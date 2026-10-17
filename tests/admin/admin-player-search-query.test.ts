import { describe, expect, it } from "vitest";
import {
  classifyAdminPlayerSearchQuery,
  normalizeAdminPlayerWhatsAppExternalId,
} from "../../src/modules/admin/player-search-query.js";

describe("admin player search query", () => {
  it("recognizes exact player UUIDs", () => {
    expect(classifyAdminPlayerSearchQuery("8d4b4a82-bdc9-4e64-8dbe-f2b524c61019")).toEqual({
      kind: "PLAYER_ID",
      playerId: "8d4b4a82-bdc9-4e64-8dbe-f2b524c61019",
    });
  });

  it("normalizes a formatted Brazilian WhatsApp number to the live Baileys identity", () => {
    expect(normalizeAdminPlayerWhatsAppExternalId("+55 (79) 99999-1234")).toBe(
      "5579999991234@s.whatsapp.net",
    );
    expect(classifyAdminPlayerSearchQuery("+55 (79) 99999-1234")).toEqual({
      kind: "WHATSAPP",
      identityProvider: "baileys",
      externalId: "5579999991234@s.whatsapp.net",
    });
  });

  it("preserves an already canonical Baileys phone JID", () => {
    expect(normalizeAdminPlayerWhatsAppExternalId("5579999991234@s.whatsapp.net")).toBe(
      "5579999991234@s.whatsapp.net",
    );
  });

  it("does not interpret short numeric text as a phone number", () => {
    expect(classifyAdminPlayerSearchQuery("12345")).toEqual({
      kind: "TRAINER_NAME",
      trainerNamePrefix: "12345",
    });
  });

  it("uses ordinary text as a trainer name prefix", () => {
    expect(classifyAdminPlayerSearchQuery("  Cynthia  ")).toEqual({
      kind: "TRAINER_NAME",
      trainerNamePrefix: "Cynthia",
    });
  });

  it("treats an empty query as no filter", () => {
    expect(classifyAdminPlayerSearchQuery("   ")).toEqual({ kind: "EMPTY" });
  });
});
