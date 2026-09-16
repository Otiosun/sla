import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const maintenance = vi.hoisted(() => ({
  provisioning: vi.fn(async () => undefined),
  battle: vi.fn(async () => ({ turns: [], defeats: [] })),
  compose: vi.fn(),
}));

vi.mock("../../src/modules/registration/provisioning-worker.js", () => ({
  PlayerProvisioningWorker: class {
    runOnce = maintenance.provisioning;
  },
}));
vi.mock("../../src/runtime/compose-pve-battle-runtime.js", () => ({
  createPveBattleRuntime: maintenance.compose,
}));

import { createPveBattleRuntime } from "../../src/runtime/compose-pve-battle-runtime.js";
import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

describe("PVE WhatsApp maintenance composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maintenance.compose.mockReturnValue({ battle: {}, runMaintenance: maintenance.battle });
  });

  it("uses explicit configuration and the existing maintenance hook on every tick", async () => {
    const pool = {} as Pool;
    const config = {
      turnWindowTtlMs: 120_000,
      maintenanceBatchSize: 3,
      encryptionKeys: new Map([[1, Buffer.alloc(32)]]),
    };
    const composition = createOperationalMessagingComposition(pool, null, null, config);
    expect(createPveBattleRuntime).toHaveBeenCalledWith(pool, config);
    expect(composition.pveBattle).not.toBeNull();
    expect(composition.admitCommand({ text: "/desafiar @treinador" } as never)).toBe(true);
    expect(composition.admitCommand({ text: "/aceitar" } as never)).toBe(true);
    await composition.runMaintenance();
    await composition.runMaintenance();
    expect(maintenance.battle).toHaveBeenCalledTimes(2);
    expect(maintenance.provisioning).toHaveBeenCalledTimes(2);
  });

  it("preserves the unconfigured runtime without choosing a TTL or migrating battles", async () => {
    const composition = createOperationalMessagingComposition({} as Pool);
    await composition.runMaintenance();
    expect(composition.pveBattle).toBeNull();
    expect(createPveBattleRuntime).not.toHaveBeenCalled();
    expect(maintenance.battle).not.toHaveBeenCalled();
    expect(maintenance.provisioning).toHaveBeenCalledOnce();
  });
});

describe("PVE explicit battle-start wiring", () => {
  it("exposes explicit narrator PVE battle start only when both runtimes are available", () => {
    const pool = {} as Pool;

    const encounterRngConfig = {
      encryptionKey: Buffer.alloc(32),
      encryptionKeyVersion: 1,
    };

    const pveConfig = {
      turnWindowTtlMs: 120_000,
      maintenanceBatchSize: 3,
      encryptionKeys: new Map([[1, Buffer.alloc(32)]]),
    };

    maintenance.compose.mockReturnValue({
      battle: {},
      runMaintenance: maintenance.battle,
    });

    const enabled = createOperationalMessagingComposition(
      pool,
      encounterRngConfig,
      null,
      pveConfig,
    );

    expect(
      enabled.admitCommand({
        text: "/iniciarbatalha @treinador",
      } as never),
    ).toBe(true);

    const withoutPve = createOperationalMessagingComposition(pool, encounterRngConfig);

    expect(
      withoutPve.admitCommand({
        text: "/iniciarbatalha @treinador",
      } as never),
    ).toBe(false);

    const withoutEncounterWriter = createOperationalMessagingComposition(
      pool,
      null,
      null,
      pveConfig,
    );

    expect(
      withoutEncounterWriter.admitCommand({
        text: "/iniciarbatalha @treinador",
      } as never),
    ).toBe(false);
  });
});
