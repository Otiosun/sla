import type { AdminOperationRegistry } from "./operation-registry.js";
import { defineAdminOperation } from "./operation-registry.js";
import {
  type AdminPlayerWhatsAppChangeInput,
  AdminPlayerWhatsAppChangeInputSchema,
} from "./player-identity-contracts.js";

const playerIdentityChangePolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function registerPlayerIdentityAdminOperations(
  registry: AdminOperationRegistry,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<AdminPlayerWhatsAppChangeInput>({
      kind: "MUTATION",
      operationType: "player.identity.whatsapp.change",
      capabilityKey: "player.identity.change",
      riskTier: 4,
      authorizationMode: "SUBJECT",
      policy: playerIdentityChangePolicy,
      inputSchema: AdminPlayerWhatsAppChangeInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
    }),
  );

  return registry;
}
