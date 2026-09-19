import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("operational contextual menu runtime wiring", () => {
  it("passes worldServiceSessions into createOperationalUxRoutes", () => {
    const source = fs.readFileSync("src/runtime/compose-whatsapp-runtime.ts", "utf8");
    const start = source.indexOf("createOperationalUxRoutes({");
    const end = source.indexOf("}).filter(", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    expect(block).toContain("sessions: worldServiceSessions,");
  });
});
