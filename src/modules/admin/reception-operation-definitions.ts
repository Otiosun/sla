import { z } from "zod";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

export const AdminSourceChannelSchema = z.enum(["WHATSAPP", "CONTROL_CENTER"]);
export type AdminSourceChannel = z.infer<typeof AdminSourceChannelSchema>;

const reviewInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    playerId: z.string().uuid(),
    sourceChannel: AdminSourceChannelSchema,
  })
  .strict();

const playerAccessInputSchema = z
  .object({
    playerId: z.string().uuid(),
    sourceChannel: AdminSourceChannelSchema,
  })
  .strict();

const communityGroupInputSchema = z
  .object({
    groupId: z.string().uuid(),
    sourceChannel: AdminSourceChannelSchema,
    action: z.enum(["RENAME", "REPLACE_CAPABILITIES", "RETIRE"]),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const receptionStaffInputSchema = z
  .object({
    groupId: z.string().uuid(),
    adminPrincipalId: z.string().uuid(),
    sourceChannel: AdminSourceChannelSchema,
    action: z.enum(["ASSIGN", "REMOVE"]),
  })
  .strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const reviewMutationPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const auditedMutationPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const staffMutationPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function registerReceptionAdminOperations(
  registry: AdminOperationRegistry,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "registration.review.read",
      capabilityKey: "player.registration.read",
      riskTier: 0,
      authorizationMode: "SUBJECT",
      policy: readPolicy,
      inputSchema: reviewInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
    }),
  );

  for (const [operationType, capabilityKey, riskTier] of [
    ["registration.review.request_changes", "player.registration.request_changes", 1],
    ["registration.review.approve", "player.registration.approve", 2],
    ["registration.review.reject", "player.registration.reject", 2],
    ["registration.review.reopen", "player.registration.reopen", 2],
  ] as const) {
    registry.register(
      defineAdminOperation({
        kind: "MUTATION",
        operationType,
        capabilityKey,
        riskTier,
        authorizationMode: "SUBJECT",
        policy: reviewMutationPolicy,
        inputSchema: reviewInputSchema,
        target: (input) => ({ type: "PLAYER", id: input.playerId }),
      }),
    );
  }

  registry.register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "player.access.suspend",
      capabilityKey: "player.access.suspend",
      riskTier: 3,
      authorizationMode: "SUBJECT",
      policy: auditedMutationPolicy,
      inputSchema: playerAccessInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
    }),
  );

  registry.register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "player.access.restore",
      capabilityKey: "player.access.restore",
      riskTier: 2,
      authorizationMode: "SUBJECT",
      policy: auditedMutationPolicy,
      inputSchema: playerAccessInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
    }),
  );

  registry.register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "community.group.manage",
      capabilityKey: "community.group.manage",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: auditedMutationPolicy,
      inputSchema: communityGroupInputSchema,
      target: (input) => ({ type: "COMMUNITY_GROUP", id: input.groupId }),
    }),
  );

  registry.register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "community.reception.staff.manage",
      capabilityKey: "community.reception.staff.manage",
      riskTier: 2,
      authorizationMode: "GLOBAL_ONLY",
      policy: staffMutationPolicy,
      inputSchema: receptionStaffInputSchema,
      target: (input) => ({ type: "COMMUNITY_GROUP", id: input.groupId }),
    }),
  );

  return registry;
}
