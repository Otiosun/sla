import { z } from "zod";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const EconomyAnalyticsReadInputSchema = z.object({}).strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function registerEconomyAnalyticsRead(
  registry: AdminOperationRegistry,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "economy.analytics.read",
      capabilityKey: "economy.read",
      riskTier: 0,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: EconomyAnalyticsReadInputSchema,
      target: () => ({ type: "SYSTEM", id: null }),
    }),
  );

  return registry;
}
