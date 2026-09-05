import type { CommandRouteDefinition } from "./router.js";

const WORLD_TRAVEL_POLICY = {
  requiredGroupCapabilities: ["world"],
  allowedPlayerAccess: ["ACTIVE"],
  requiresMechanicalReady: true,
} as const;

export function withOperationalWorldPolicy(
  definitions: readonly CommandRouteDefinition[],
): readonly CommandRouteDefinition[] {
  return definitions.map((definition) =>
    definition.command === "ir" ? { ...definition, policy: WORLD_TRAVEL_POLICY } : definition,
  );
}
