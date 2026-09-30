import type { PveBattleRuntimeConfig } from "./compose-pve-battle-runtime.js";
import type { EncounterRngRuntimeConfig } from "./encounter-rng-runtime-config.js";

const DEFAULT_TURN_WINDOW_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAINTENANCE_BATCH_SIZE = 25;

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive safe integer when explicitly configured`);
  }
  return Number(value);
}

export function loadPveBattleRuntimeConfig(
  rng: EncounterRngRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): PveBattleRuntimeConfig {
  return {
    turnWindowTtlMs: positiveInteger(
      env.PVE_TURN_WINDOW_TTL_MS,
      "PVE_TURN_WINDOW_TTL_MS",
      DEFAULT_TURN_WINDOW_TTL_MS,
    ),
    maintenanceBatchSize: positiveInteger(
      env.PVE_MAINTENANCE_BATCH_SIZE,
      "PVE_MAINTENANCE_BATCH_SIZE",
      DEFAULT_MAINTENANCE_BATCH_SIZE,
    ),
    encryptionKeys: new Map([[rng.encryptionKeyVersion, rng.encryptionKey]]),
  };
}
