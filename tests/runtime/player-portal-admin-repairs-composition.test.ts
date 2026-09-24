import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimePath = fileURLToPath(
  new URL("../../src/runtime/compose-player-portal-runtime.ts", import.meta.url),
);
const source = readFileSync(runtimePath, "utf8");

describe("Player Portal admin repair composition", () => {
  it("registers battle and encounter repair operations into the same live registry", () => {
    expect(source).toContain("registerPhase12CBattleAdminOperations(adminRegistry, battleAdmin)");
    expect(source).toContain(
      "registerPhase12CEncounterAdminOperations(adminRegistry, encounterAdmin)",
    );
    expect(source).toContain("new PostgresBattleAdminRepository(options.pool)");
    expect(source).toContain("new PostgresBattleCancellation(options.pool)");
    expect(source).toContain("new PostgresEncounterAdminRepository(options.pool)");

    const serviceIndex = source.indexOf(
      "const adminService = new AdminService(adminRegistry, adminRepository)",
    );
    const battleIndex = source.indexOf(
      "registerPhase12CBattleAdminOperations(adminRegistry, battleAdmin)",
    );
    const encounterIndex = source.indexOf(
      "registerPhase12CEncounterAdminOperations(adminRegistry, encounterAdmin)",
    );

    expect(serviceIndex).toBeGreaterThan(-1);
    expect(battleIndex).toBeGreaterThan(serviceIndex);
    expect(encounterIndex).toBeGreaterThan(serviceIndex);
  });

  it("keeps encounter CAS revision in Player 360 instead of blind force-close", () => {
    const contractPath = fileURLToPath(
      new URL("../../src/modules/admin/player360-contracts.ts", import.meta.url),
    );
    const contractSource = readFileSync(contractPath, "utf8");
    expect(contractSource).toMatch(
      /interface Player360EncounterView[\s\S]*readonly revision: string;/,
    );
  });
});
