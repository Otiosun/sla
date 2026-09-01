import { z } from "zod";
import {
  AdminRoleAssignInputSchema,
  AdminSessionRevokeAllInputSchema,
  type AdminRoleAssignInput,
  type AdminSessionRevokeAllInput,
} from "./contracts.js";
import { AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";
import type { AdminRoleAssignmentPort, AdminSessionRevocationPort } from "./ports.js";

const playerReadSchema = z.object({ playerId: z.string().uuid() }).strict();
const playerCollectionReadSchema = z.object({}).strict();
const contentCollectionReadSchema = z.object({}).strict();
const adminOperationAuditReadSchema = z.object({ operationId: z.string().uuid() }).strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

function sessionRevocationPortFrom(
  roleAssignmentPort: AdminRoleAssignmentPort,
  explicit: AdminSessionRevocationPort | undefined,
): AdminSessionRevocationPort | null {
  if (explicit !== undefined) return explicit;
  if (
    "simulateSessionRevocation" in roleAssignmentPort &&
    typeof roleAssignmentPort.simulateSessionRevocation === "function" &&
    "applySessionRevocation" in roleAssignmentPort &&
    typeof roleAssignmentPort.applySessionRevocation === "function"
  ) {
    return roleAssignmentPort as AdminRoleAssignmentPort & AdminSessionRevocationPort;
  }
  return null;
}

export function createPhase12AdminOperationRegistry(
  roleAssignmentPort: AdminRoleAssignmentPort,
  explicitSessionRevocationPort?: AdminSessionRevocationPort,
): AdminOperationRegistry {
  const registry = new AdminOperationRegistry();
  const sessionRevocationPort = sessionRevocationPortFrom(
    roleAssignmentPort,
    explicitSessionRevocationPort,
  );

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
    defineAdminOperation({
      kind: "READ",
      operationType: "admin.operation.audit",
      capabilityKey: "audit.read",
      riskTier: 0,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: adminOperationAuditReadSchema,
      target: (input) => ({ type: "ADMIN_OPERATION", id: input.operationId }),
    }),
  );

  for (const definition of [
    {
      operationType: "content.library.search.create",
      capabilityKey: "content.draft.create",
      riskTier: 3 as const,
    },
    {
      operationType: "content.library.search.edit",
      capabilityKey: "content.draft.edit",
      riskTier: 3 as const,
    },
    {
      operationType: "content.library.search.validate",
      capabilityKey: "content.validate",
      riskTier: 3 as const,
    },
    {
      operationType: "content.library.search.publish",
      capabilityKey: "content.publish",
      riskTier: 4 as const,
    },
  ]) {
    registry.register(
      defineAdminOperation({
        kind: "READ",
        operationType: definition.operationType,
        capabilityKey: definition.capabilityKey,
        riskTier: definition.riskTier,
        authorizationMode: "GLOBAL_ONLY",
        policy: readPolicy,
        inputSchema: contentCollectionReadSchema,
        target: () => ({ type: "CONTENT_COLLECTION", id: null }),
      }),
    );
  }

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

  registry.register(
    defineAdminOperation<AdminSessionRevokeAllInput>({
      kind: "MUTATION",
      operationType: "admin.session.revoke_all",
      capabilityKey: "admin.session.revoke",
      riskTier: 4,
      authorizationMode: "GLOBAL_ONLY",
      policy: {
        version: 1,
        requiresReason: true,
        requiresExpectedRevision: false,
        requiresSimulation: true,
        requiresConfirmation: true,
        requiredApprovals: 1,
      },
      inputSchema: AdminSessionRevokeAllInputSchema,
      target: (input) => ({ type: "ADMIN_PRINCIPAL", id: input.principalId }),
      simulate: async (input) => {
        if (sessionRevocationPort === null) {
          throw new Error("Admin session revocation port is not configured");
        }
        return sessionRevocationPort.simulateSessionRevocation(input);
      },
      apply: async (context, input) => {
        if (sessionRevocationPort === null) {
          throw new Error("Admin session revocation port is not configured");
        }
        return sessionRevocationPort.applySessionRevocation(
          context.operation,
          context.actorPrincipalId,
          input,
        );
      },
    }),
  );

  return registry;
}
