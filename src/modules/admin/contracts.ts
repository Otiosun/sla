import { z } from "zod";

export const AdminRiskTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type AdminRiskTier = z.infer<typeof AdminRiskTierSchema>;

export const AdminScopeTypeSchema = z.enum(["GLOBAL", "PLAYER", "REGION", "AREA"]);
export type AdminScopeType = z.infer<typeof AdminScopeTypeSchema>;

export const AdminOperationStatusSchema = z.enum([
  "DRAFT",
  "VALIDATED",
  "SIMULATED",
  "PENDING_CONFIRMATION",
  "PENDING_APPROVAL",
  "READY",
  "APPLIED",
  "REJECTED",
  "FAILED",
  "COMPENSATED",
]);
export type AdminOperationStatus = z.infer<typeof AdminOperationStatusSchema>;

export const AdminOperationKindSchema = z.enum(["READ", "MUTATION"]);
export type AdminOperationKind = z.infer<typeof AdminOperationKindSchema>;

export const AdminAuthorizationModeSchema = z.enum(["GLOBAL_ONLY", "SUBJECT"]);
export type AdminAuthorizationMode = z.infer<typeof AdminAuthorizationModeSchema>;

const tokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const AdminOperationPolicySchema = z
  .object({
    version: z.number().int().positive(),
    requiresReason: z.boolean(),
    requiresExpectedRevision: z.boolean(),
    requiresSimulation: z.boolean(),
    requiresConfirmation: z.boolean(),
    requiredApprovals: z.number().int().min(0).max(2),
  })
  .strict();
export type AdminOperationPolicy = z.infer<typeof AdminOperationPolicySchema>;

export interface AdminTarget {
  readonly type: string;
  readonly id: string | null;
}

export interface AdminScope {
  readonly scopeType: AdminScopeType;
  readonly scopeId: string | null;
}

export interface AdminCapabilityGrant {
  readonly key: string;
  readonly riskTier: AdminRiskTier;
}

export interface AdminAuthorizationSnapshot {
  readonly principalId: string;
  readonly status: "ACTIVE" | "DISABLED";
  readonly capabilities: readonly AdminCapabilityGrant[];
  readonly scopes: readonly AdminScope[];
}

export const AdminMutationRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    operationType: tokenSchema,
    input: z.record(z.string(), z.unknown()),
    reason: z.string().trim().min(1).max(2000).optional(),
    expectedRevision: z.coerce.bigint().nonnegative().optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
    correlationId: z.string().uuid(),
  })
  .strict();
export type AdminMutationRequest = z.infer<typeof AdminMutationRequestSchema>;

export const AdminReadAuthorizationRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    operationType: tokenSchema,
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AdminReadAuthorizationRequest = z.infer<typeof AdminReadAuthorizationRequestSchema>;

export const AdminRoleAssignInputSchema = z
  .object({
    principalId: z.string().uuid(),
    roleId: z.string().uuid(),
  })
  .strict();
export type AdminRoleAssignInput = z.infer<typeof AdminRoleAssignInputSchema>;

export interface AdminSimulationResult {
  readonly summary: Readonly<Record<string, unknown>>;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

export interface AdminOperationRecord {
  readonly id: string;
  readonly principalId: string;
  readonly capabilityKey: string;
  readonly operationType: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly riskTier: AdminRiskTier;
  readonly authorizationMode: AdminAuthorizationMode;
  readonly status: AdminOperationStatus;
  readonly reason: string | null;
  readonly expectedRevision: bigint | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly correlationId: string;
  readonly policy: AdminOperationPolicy;
  readonly revision: bigint;
  readonly appliedAt: Date | null;
}

export interface AdminPreparedOperation {
  readonly operation: AdminOperationRecord;
  readonly replayed: boolean;
}
