import { createHash } from "node:crypto";
import type { z } from "zod";
import type {
  AdminAuthorizationMode,
  AdminOperationKind,
  AdminOperationPolicy,
  AdminOperationRecord,
  AdminRiskTier,
  AdminSimulationResult,
  AdminTarget,
} from "./contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";

export interface AdminOperationApplyContext {
  readonly operation: AdminOperationRecord;
  readonly actorPrincipalId: string;
}

export interface AdminOperationDefinition {
  readonly kind: AdminOperationKind;
  readonly operationType: string;
  readonly capabilityKey: string;
  readonly riskTier: AdminRiskTier;
  readonly authorizationMode: AdminAuthorizationMode;
  readonly policy: AdminOperationPolicy;
  parseInput(raw: unknown): unknown;
  target(input: unknown): AdminTarget;
  simulate?: (input: unknown) => Promise<AdminSimulationResult>;
  apply?: (context: AdminOperationApplyContext, input: unknown) => Promise<AdminOperationRecord>;
}

interface DefineAdminOperationInput<T> {
  readonly kind: AdminOperationKind;
  readonly operationType: string;
  readonly capabilityKey: string;
  readonly riskTier: AdminRiskTier;
  readonly authorizationMode: AdminAuthorizationMode;
  readonly policy: AdminOperationPolicy;
  readonly inputSchema: z.ZodType<T>;
  readonly target: (input: T) => AdminTarget;
  readonly simulate?: (input: T) => Promise<AdminSimulationResult>;
  readonly apply?: (context: AdminOperationApplyContext, input: T) => Promise<AdminOperationRecord>;
}

export function defineAdminOperation<T>(
  input: DefineAdminOperationInput<T>,
): AdminOperationDefinition {
  if (input.kind === "READ") {
    if (
      input.policy.requiresReason ||
      input.policy.requiresExpectedRevision ||
      input.policy.requiresSimulation ||
      input.policy.requiresConfirmation ||
      input.policy.requiredApprovals !== 0 ||
      input.simulate !== undefined ||
      input.apply !== undefined
    ) {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_INPUT,
        `Read operation ${input.operationType} cannot declare mutation gates`,
      );
    }
  }
  if (input.policy.requiredApprovals > 0 && input.kind !== "MUTATION") {
    throw new AdminError(
      ADMIN_ERROR_CODES.INVALID_INPUT,
      `Only mutations can require approvals: ${input.operationType}`,
    );
  }
  return {
    kind: input.kind,
    operationType: input.operationType,
    capabilityKey: input.capabilityKey,
    riskTier: input.riskTier,
    authorizationMode: input.authorizationMode,
    policy: input.policy,
    parseInput(raw: unknown): T {
      const parsed = input.inputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid admin operation input", {
          operationType: input.operationType,
          issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
        });
      }
      return parsed.data;
    },
    target(raw: unknown): AdminTarget {
      return input.target(raw as T);
    },
    ...(input.simulate === undefined
      ? {}
      : {
          simulate: async (raw: unknown) =>
            input.simulate?.(raw as T) as Promise<AdminSimulationResult>,
        }),
    ...(input.apply === undefined
      ? {}
      : {
          apply: async (context: AdminOperationApplyContext, raw: unknown) =>
            input.apply?.(context, raw as T) as Promise<AdminOperationRecord>,
        }),
  };
}

export class AdminOperationRegistry {
  readonly #definitions = new Map<string, AdminOperationDefinition>();

  public register(definition: AdminOperationDefinition): this {
    if (this.#definitions.has(definition.operationType)) {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_INPUT,
        `Duplicate admin operation ${definition.operationType}`,
      );
    }
    this.#definitions.set(definition.operationType, definition);
    return this;
  }

  public require(operationType: string): AdminOperationDefinition {
    const definition = this.#definitions.get(operationType);
    if (definition === undefined) {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_NOT_REGISTERED,
        `Admin operation is not registered: ${operationType}`,
      );
    }
    return definition;
  }

  public list(): readonly AdminOperationDefinition[] {
    return [...this.#definitions.values()];
  }
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    );
  }
  return value;
}

export function adminRequestFingerprint(input: {
  readonly principalId: string;
  readonly definition: AdminOperationDefinition;
  readonly parsedInput: unknown;
  readonly target: AdminTarget;
  readonly reason: string | null;
  readonly expectedRevision: bigint | null;
}): string {
  const body = normalize({
    principalId: input.principalId,
    operationType: input.definition.operationType,
    capabilityKey: input.definition.capabilityKey,
    riskTier: input.definition.riskTier,
    input: input.parsedInput,
    target: input.target,
    reason: input.reason,
    expectedRevision: input.expectedRevision,
    policy: input.definition.policy,
  });
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
