import { randomUUID } from "node:crypto";
import {
  AdminMutationRequestSchema,
  AdminReadAuthorizationRequestSchema,
  type AdminAuthorizationSnapshot,
  type AdminOperationRecord,
  type AdminOperationStatus,
  type AdminPreparedOperation,
  type AdminScope,
  type AdminTarget,
} from "./contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import {
  adminRequestFingerprint,
  type AdminOperationDefinition,
  type AdminOperationRegistry,
} from "./operation-registry.js";
import type { AdminOperationRepository } from "./ports.js";

function hasGlobalScope(scopes: readonly AdminScope[]): boolean {
  return scopes.some((scope) => scope.scopeType === "GLOBAL" && scope.scopeId === null);
}

function hasSubjectScope(scopes: readonly AdminScope[], target: AdminTarget): boolean {
  if (hasGlobalScope(scopes)) return true;
  if (target.id === null) return false;
  if (!(["PLAYER", "REGION", "AREA"] as const).includes(target.type as never)) return false;
  return scopes.some((scope) => scope.scopeType === target.type && scope.scopeId === target.id);
}

function nextStatusAfterValidation(definition: AdminOperationDefinition): AdminOperationStatus {
  if (definition.policy.requiresSimulation) return "VALIDATED";
  if (definition.policy.requiresConfirmation) return "PENDING_CONFIRMATION";
  if (definition.policy.requiredApprovals > 0) return "PENDING_APPROVAL";
  return "READY";
}

function nextStatusAfterSimulation(definition: AdminOperationDefinition): AdminOperationStatus {
  if (definition.policy.requiresConfirmation) return "PENDING_CONFIRMATION";
  if (definition.policy.requiredApprovals > 0) return "PENDING_APPROVAL";
  return "READY";
}

export class AdminService {
  public constructor(
    private readonly registry: AdminOperationRegistry,
    private readonly repository: AdminOperationRepository,
  ) {}

  private async requireAuthorized(
    principalId: string,
    definition: AdminOperationDefinition,
    target: AdminTarget,
  ): Promise<AdminAuthorizationSnapshot> {
    const snapshot = await this.repository.getAuthorizationSnapshot(principalId);
    if (snapshot === null) {
      throw new AdminError(ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND, "Admin principal not found");
    }
    if (snapshot.status !== "ACTIVE") {
      throw new AdminError(ADMIN_ERROR_CODES.PRINCIPAL_DISABLED, "Admin principal is disabled");
    }
    const capability = snapshot.capabilities.find(
      (grant) => grant.key === definition.capabilityKey,
    );
    if (capability === undefined) {
      throw new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Capability denied", {
        capabilityKey: definition.capabilityKey,
      });
    }
    if (capability.riskTier !== definition.riskTier) {
      throw new AdminError(
        ADMIN_ERROR_CODES.CAPABILITY_POLICY_DRIFT,
        "Persisted capability risk tier differs from registry policy",
        { capabilityKey: definition.capabilityKey },
      );
    }
    const scopeAllowed =
      definition.authorizationMode === "GLOBAL_ONLY"
        ? hasGlobalScope(snapshot.scopes)
        : hasSubjectScope(snapshot.scopes, target);
    if (!scopeAllowed) {
      throw new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Object scope denied", {
        targetType: target.type,
        targetId: target.id,
      });
    }
    return snapshot;
  }

  public async authorizeRead(rawRequest: unknown): Promise<AdminTarget> {
    const parsed = AdminReadAuthorizationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid admin read request");
    }
    const definition = this.registry.require(parsed.data.operationType);
    if (definition.kind !== "READ") {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_KIND_MISMATCH,
        "Mutation operation cannot be used as a read authorization",
      );
    }
    const input = definition.parseInput(parsed.data.input);
    const target = definition.target(input);
    await this.requireAuthorized(parsed.data.principalId, definition, target);
    return target;
  }

  public async prepareMutation(rawRequest: unknown): Promise<AdminPreparedOperation> {
    const parsed = AdminMutationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid admin mutation request");
    }
    const definition = this.registry.require(parsed.data.operationType);
    if (definition.kind !== "MUTATION") {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_KIND_MISMATCH,
        "Read operation cannot be prepared as a mutation",
      );
    }
    const input = definition.parseInput(parsed.data.input);
    const target = definition.target(input);
    await this.requireAuthorized(parsed.data.principalId, definition, target);

    if (definition.policy.requiresReason && parsed.data.reason === undefined) {
      throw new AdminError(ADMIN_ERROR_CODES.REASON_REQUIRED, "Admin mutation requires a reason");
    }
    if (definition.policy.requiresExpectedRevision && parsed.data.expectedRevision === undefined) {
      throw new AdminError(
        ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
        "Admin mutation requires expectedRevision",
      );
    }

    const reason = parsed.data.reason ?? null;
    const expectedRevision = parsed.data.expectedRevision ?? null;
    const requestFingerprint = adminRequestFingerprint({
      principalId: parsed.data.principalId,
      definition,
      parsedInput: input,
      target,
      reason,
      expectedRevision,
    });
    const created = await this.repository.createOrReplayOperation({
      id: randomUUID(),
      principalId: parsed.data.principalId,
      capabilityKey: definition.capabilityKey,
      operationType: definition.operationType,
      target,
      riskTier: definition.riskTier,
      status: nextStatusAfterValidation(definition),
      reason,
      expectedRevision,
      idempotencyKey: parsed.data.idempotencyKey,
      requestFingerprint,
      input: input as Readonly<Record<string, unknown>>,
      correlationId: parsed.data.correlationId,
      policyVersion: definition.policy.version,
      requiresSimulation: definition.policy.requiresSimulation,
      requiresConfirmation: definition.policy.requiresConfirmation,
      requiredApprovals: definition.policy.requiredApprovals,
    });
    if (created.operation.requestFingerprint !== requestFingerprint) {
      throw new AdminError(
        ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "Idempotency key was reused with different admin operation semantics",
      );
    }
    return { operation: created.operation, replayed: created.replayed };
  }

  public async simulate(
    operationId: string,
    actorPrincipalId: string,
  ): Promise<AdminOperationRecord> {
    const operation = await this.requireOperation(operationId);
    const definition = this.registry.require(operation.operationType);
    if (operation.principalId !== actorPrincipalId) {
      throw new AdminError(
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Only the proposing principal may simulate this operation",
      );
    }
    const input = definition.parseInput(operation.input);
    await this.requireAuthorized(actorPrincipalId, definition, definition.target(input));
    if (operation.status !== "VALIDATED" || definition.simulate === undefined) {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
        `Operation cannot be simulated from ${operation.status}`,
      );
    }
    const simulation = await definition.simulate(input);
    return this.repository.saveSimulation(
      operation.id,
      operation.revision,
      simulation,
      nextStatusAfterSimulation(definition),
    );
  }

  public async confirm(
    operationId: string,
    actorPrincipalId: string,
  ): Promise<AdminOperationRecord> {
    const operation = await this.requireOperation(operationId);
    const definition = this.registry.require(operation.operationType);
    if (operation.principalId !== actorPrincipalId) {
      throw new AdminError(
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Only the proposing principal may confirm this operation",
      );
    }
    const input = definition.parseInput(operation.input);
    await this.requireAuthorized(actorPrincipalId, definition, definition.target(input));
    const nextStatus = definition.policy.requiredApprovals > 0 ? "PENDING_APPROVAL" : "READY";
    return this.repository.recordConfirmation(
      operation.id,
      actorPrincipalId,
      operation.requestFingerprint,
      nextStatus,
    );
  }

  public async approve(
    operationId: string,
    actorPrincipalId: string,
    reason: string,
  ): Promise<AdminOperationRecord> {
    const operation = await this.requireOperation(operationId);
    const definition = this.registry.require(operation.operationType);
    if (operation.principalId === actorPrincipalId) {
      throw new AdminError(
        ADMIN_ERROR_CODES.SELF_APPROVAL_FORBIDDEN,
        "Operation proposer cannot approve their own operation",
      );
    }
    const input = definition.parseInput(operation.input);
    await this.requireAuthorized(actorPrincipalId, definition, definition.target(input));
    if (reason.trim().length === 0) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Approval reason is required");
    }
    return this.repository.recordApproval(
      operation.id,
      actorPrincipalId,
      operation.requestFingerprint,
      reason.trim(),
    );
  }

  public async apply(operationId: string, actorPrincipalId: string): Promise<AdminOperationRecord> {
    const operation = await this.requireOperation(operationId);
    if (operation.status === "APPLIED") return operation;
    const definition = this.registry.require(operation.operationType);
    const input = definition.parseInput(operation.input);
    await this.requireAuthorized(actorPrincipalId, definition, definition.target(input));
    if (operation.status !== "READY" || definition.apply === undefined) {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
        `Operation cannot be applied from ${operation.status}`,
      );
    }
    return definition.apply({ operation, actorPrincipalId }, input);
  }

  private async requireOperation(operationId: string): Promise<AdminOperationRecord> {
    const operation = await this.repository.getOperation(operationId);
    if (operation === null) {
      throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
    }
    return operation;
  }
}
