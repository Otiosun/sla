import { z } from "zod";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const PlayerActivityAnalyticsReadInputSchema = z.object({}).strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function registerPlayerActivityAnalyticsRead(
  registry: AdminOperationRegistry,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "player.activity.read",
      capabilityKey: "player.read",
      riskTier: 0,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: PlayerActivityAnalyticsReadInputSchema,
      target: () => ({ type: "SYSTEM", id: null }),
    }),
  );

  return registry;
}
