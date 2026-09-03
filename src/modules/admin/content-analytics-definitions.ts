import { z } from "zod";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const ContentAnalyticsReadInputSchema = z.object({}).strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function registerContentAnalyticsRead(
  registry: AdminOperationRegistry,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "content.analytics.read",
      capabilityKey: "content.analytics.read",
      riskTier: 0,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: ContentAnalyticsReadInputSchema,
      target: () => ({ type: "SYSTEM", id: null }),
    }),
  );

  return registry;
}
