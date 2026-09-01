import { z } from "zod";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const RuntimeWhatsappHealthReadInputSchema = z.object({}).strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function registerRuntimeWhatsappHealthRead(
  registry: AdminOperationRegistry,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "runtime.whatsapp.health.read",
      capabilityKey: "runtime.health.read",
      riskTier: 0,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: RuntimeWhatsappHealthReadInputSchema,
      target: () => ({ type: "RUNTIME", id: null }),
    }),
  );

  return registry;
}
