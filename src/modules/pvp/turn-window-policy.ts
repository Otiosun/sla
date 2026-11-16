/**
 * Owner-approved PvP turn default (26/10/2026): 12 hours, never the PvE
 * window. This only defines the fallback for a newly created turn; persisted
 * turn deadlines must remain untouched when group policy changes.
 *
 * Per-group authorized overrides require their own audited storage and
 * cannot be implemented by reusing the PvE runtime setting.
 */
export const DEFAULT_PVP_TURN_WINDOW_TTL_MS = 12 * 60 * 60 * 1_000;

export function initialPvpTiming(pveTurnWindowTtlMs: number): {
  readonly challengeTtlMs: number;
  readonly turnWindowTtlMs: number;
} {
  if (!Number.isSafeInteger(pveTurnWindowTtlMs) || pveTurnWindowTtlMs <= 0) {
    throw new Error("PvE fallback challenge TTL must be a positive safe integer");
  }
  return {
    // Challenge expiration remains on the existing policy until explicitly
    // approved. It is intentionally independent of a PvP battle turn deadline.
    challengeTtlMs: pveTurnWindowTtlMs,
    turnWindowTtlMs: DEFAULT_PVP_TURN_WINDOW_TTL_MS,
  };
}
