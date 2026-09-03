import { z } from "zod";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const GameplayAnalyticsReadInputSchema = z.object({}).strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function registerGameplayAnalyticsRead(
  registry: AdminOperationRegistry,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "gameplay.analytics.read",
      capabilityKey: "world.read",
      riskTier: 0,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: GameplayAnalyticsReadInputSchema,
      target: () => ({ type: "SYSTEM", id: null }),
    }),
  );

  return registry;
}
