import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("short travel lock player ingress contract", () => {
  it("keeps POST_ARRIVAL separate and blocks repeated /ir at the player front", () => {
    const repository = fs.readFileSync("src/platform/world/postgres-world-repository.ts", "utf8");
    const handlers = fs.readFileSync("src/modules/messaging/operational-ux-handlers.ts", "utf8");

    const cooldownStart = repository.indexOf("public async travelCooldownUntil");
    const cooldownEnd = repository.indexOf("\n  public async ", cooldownStart + 10);
    const cooldownMethod = repository.slice(
      cooldownStart,
      cooldownEnd >= 0 ? cooldownEnd : repository.length,
    );

    expect(cooldownMethod).toContain("reason = 'POST_ARRIVAL'");
    expect(handlers).toContain("travelLockBeforeMove");
    expect(handlers).toContain("travelInProgressText()");
  });
});
