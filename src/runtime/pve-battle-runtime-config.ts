import type { PveBattleRuntimeConfig } from "./compose-pve-battle-runtime.js";
import type { EncounterRngRuntimeConfig } from "./encounter-rng-runtime-config.js";

export function loadPveBattleRuntimeConfig(
  rng: EncounterRngRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): PveBattleRuntimeConfig | null {
  const ttl = env.PVE_TURN_WINDOW_TTL_MS;
  const batch = env.PVE_MAINTENANCE_BATCH_SIZE;
  if (ttl === undefined && batch === undefined) return null;
  function positiveInteger(value: string | undefined, name: string): number {
    if (value === undefined || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${name} must be an explicit positive safe integer`);
    }
    return Number(value);
  }
  return {
    turnWindowTtlMs: positiveInteger(ttl, "PVE_TURN_WINDOW_TTL_MS"),
    maintenanceBatchSize: positiveInteger(batch, "PVE_MAINTENANCE_BATCH_SIZE"),
    encryptionKeys: new Map([[rng.encryptionKeyVersion, rng.encryptionKey]]),
  };
}
