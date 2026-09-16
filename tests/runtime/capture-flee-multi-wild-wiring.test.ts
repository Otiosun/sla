import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("multi-wild capture/flee wiring", () => {
  it("persists a durable wild target and can continue a wild battle after capture", () => {
    const capture = fs.readFileSync("src/platform/capture/postgres-capture-repository.ts", "utf8");
    expect(capture).toContain("target_wild_no");
    expect(capture).toContain("encounter_wild_snapshots");
    expect(capture).toContain("active_member = FALSE");
    expect(capture).toContain("openControllerTurnWindowInTransaction");
    expect(capture).toContain("encounterContinues: !terminal");
  });

  it("routes capture/flee through the compact PVE front and follows the active wild controller", () => {
    const scene = fs.readFileSync("src/modules/battle/pve-scene-whatsapp.ts", "utf8");
    expect(scene).toContain("dependencies.capture.attempt");
    expect(scene).toContain("dependencies.encounterWriter.flee");
    expect(scene).toContain("entry.participantId === activeWild.participantId");
    expect(scene).toContain('state.value.battleType === "PVP"');
    expect(scene).toContain("use `/desistir`");
  });

  it("loads the full wild roster for operational encounter reads", () => {
    const read = fs.readFileSync("src/modules/encounter/operational-read-service.ts", "utf8");
    expect(read).toContain("transaction.wildSnapshots");
  });

  it("closes the Encounter when a wild battle reaches a terminal flee/result", () => {
    const battle = fs.readFileSync("src/platform/battle/postgres-battle-repository.ts", "utf8");
    expect(battle).toContain('input.nextState.battleType === "WILD"');
    expect(battle).toContain('input.nextState.status === "FLED" ? "FLED" : "CLOSED"');
  });

  it("wires capture service and human Ball discovery into both PVE scene entry points", () => {
    const runtime = fs.readFileSync("src/runtime/compose-whatsapp-runtime.ts", "utf8");
    expect(runtime).toContain("new PostgresCaptureRepository");
    expect(runtime).toContain("new PostgresCaptureBallReader");
    expect(runtime.match(/captureBalls/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
