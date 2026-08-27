import { z } from "zod";
import { AdminRoleAssignInputSchema, type AdminRoleAssignInput } from "./contracts.js";
import { AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";
import type { AdminRoleAssignmentPort } from "./ports.js";

const playerReadSchema = z.object({ playerId: z.string().uuid() }).strict();
const playerCollectionReadSchema = z.object({}).strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function createPhase12AdminOperationRegistry(
  roleAssignmentPort: AdminRoleAssignmentPort,
): AdminOperationRegistry {
  const registry = new AdminOperationRegistry();

  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "player.read",
      capabilityKey: "player.read",
      riskTier: 0,
      authorizationMode: "SUBJECT",
      policy: readPolicy,
      inputSchema: playerReadSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
    }),
  );

  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "player.read_sensitive",
      capabilityKey: "player.read_sensitive",
      riskTier: 0,
      authorizationMode: "SUBJECT",
      policy: readPolicy,
      inputSchema: playerReadSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
    }),
  );

  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "player.search",
      capabilityKey: "player.read",
      riskTier: 0,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: playerCollectionReadSchema,
      target: () => ({ type: "PLAYER_COLLECTION", id: null }),
    }),
  );

  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "player.search_sensitive",
      capabilityKey: "player.read_sensitive",
      riskTier: 0,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: playerCollectionReadSchema,
      target: () => ({ type: "PLAYER_COLLECTION", id: null }),
    }),
  );

  registry.register(
    defineAdminOperation<AdminRoleAssignInput>({
      kind: "MUTATION",
      operationType: "admin.role.assign",
      capabilityKey: "admin.role.assign",
      riskTier: 4,
      authorizationMode: "GLOBAL_ONLY",
      policy: {
        version: 1,
        requiresReason: true,
        requiresExpectedRevision: true,
        requiresSimulation: true,
        requiresConfirmation: true,
        requiredApprovals: 1,
      },
      inputSchema: AdminRoleAssignInputSchema,
      target: (input) => ({ type: "ADMIN_PRINCIPAL", id: input.principalId }),
      simulate: (input) => roleAssignmentPort.simulateRoleAssignment(input),
      apply: (context, input) =>
        roleAssignmentPort.applyRoleAssignment(context.operation, context.actorPrincipalId, input),
    }),
  );

  return registry;
}
