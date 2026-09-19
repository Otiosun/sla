import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("narrator encounter environment wiring", () => {
  it("keeps the environment provider at the WhatsApp spawn boundary, not inside EncounterService", () => {
    const spawn = fs.readFileSync("src/modules/encounter/spawn-whatsapp.ts", "utf8");
    const compose = fs.readFileSync("src/runtime/compose-whatsapp-runtime.ts", "utf8");
    const service = fs.readFileSync("src/modules/encounter/service.ts", "utf8");

    expect(spawn).toContain("readonly environment?: () => EncounterEnvironmentContext;");
    expect(spawn).toContain("environment: dependencies.environment()");
    expect(compose).toContain("resolveNarratorEncounterEnvironment");
    expect(compose).toContain(
      "environment: () => resolveNarratorEncounterEnvironment(process.env)",
    );

    expect(service).not.toContain("resolveNarratorEncounterEnvironment");
    expect(service).not.toContain("BELL_WORLD_TIME_OF_DAY");
  });
});
