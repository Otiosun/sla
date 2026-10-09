import { describe, expect, it } from "vitest";
import { parseCompetitiveSpawnToggle } from "../../src/modules/competitive-spawn/settings.js";

describe("competitive spawn group toggle parsing", () => {
  it("defaults an empty /competitivo command to status", () => {
    expect(parseCompetitiveSpawnToggle("/competitivo")).toBe("STATUS");
    expect(parseCompetitiveSpawnToggle("/competitivo status")).toBe("STATUS");
  });

  it("accepts explicit enable and disable forms", () => {
    expect(parseCompetitiveSpawnToggle("/competitivo ativar")).toBe("ENABLE");
    expect(parseCompetitiveSpawnToggle("/competitivo on")).toBe("ENABLE");
    expect(parseCompetitiveSpawnToggle("/competitivo desativar")).toBe("DISABLE");
    expect(parseCompetitiveSpawnToggle("/competitivo off")).toBe("DISABLE");
  });

  it("rejects unknown actions", () => {
    expect(parseCompetitiveSpawnToggle("/competitivo talvez")).toBeNull();
  });
});
