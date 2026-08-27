import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AdminRoleAssignInputSchema } from "../../src/modules/admin/contracts.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import {
  AdminOperationRegistry,
  defineAdminOperation,
} from "../../src/modules/admin/operation-registry.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

function expectAdminCode(error: unknown, code: string): void {
  if (!(error instanceof AdminError) || error.code !== code) {
    throw error instanceof Error ? error : new Error(`Expected ${code}`);
  }
}

function expectCheckViolation(error: unknown): void {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { readonly code?: unknown }).code !== "23514"
  ) {
    throw error instanceof Error ? error : new Error("Expected PostgreSQL check violation");
  }
}

const pool = new Pool({ connectionString: databaseUrl, max: 6 });
try {
  const ownerRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'OWNER_SECURITY_ADMIN'`,
  );
  const supportRole = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'SUPPORT'`,
  );
  const ownerRoleId = ownerRole.rows[0]?.id;
  const supportRoleId = supportRole.rows[0]?.id;
  if (ownerRoleId === undefined || supportRoleId === undefined)
    throw new Error("Phase 12 roles are not seeded");

  const roleAssignCapability = await pool.query<{ id: string }>(
    `SELECT id FROM capabilities WHERE key = 'admin.role.assign'`,
  );
  const roleAssignCapabilityId = roleAssignCapability.rows[0]?.id;
  if (roleAssignCapabilityId === undefined) throw new Error("admin.role.assign capability missing");
  await pool.query(
    `INSERT INTO admin_role_capabilities(role_id, capability_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [supportRoleId, roleAssignCapabilityId],
  );
  execFileSync(process.execPath, ["--import", "tsx", "db/seeds/phase12_admin_registry_slice.ts"], {
    env: process.env,
    stdio: "pipe",
  });
  const staleSupportGrant = await pool.query(
    `SELECT 1
     FROM admin_role_capabilities relation
     JOIN capabilities capability ON capability.id = relation.capability_id
     WHERE relation.role_id = $1 AND capability.key = 'admin.role.assign'`,
    [supportRoleId],
  );
  if (staleSupportGrant.rowCount !== 0) {
    throw new Error("Phase 12 role seed failed to remove stale SUPPORT capability");
  }

  const proposerId = randomUUID();
  const approverId = randomUUID();
  const scopedSupportId = randomUUID();
  const targetAdminId = randomUUID();
  const staleTargetId = randomUUID();
  const driftTargetId = randomUUID();
  const allowedPlayerId = randomUUID();
  const otherPlayerId = randomUUID();

  for (const [id, identity] of [
    [proposerId, "proof:proposer"],
    [approverId, "proof:approver"],
    [scopedSupportId, "proof:scoped-support"],
    [targetAdminId, "proof:target"],
    [staleTargetId, "proof:stale-target"],
    [driftTargetId, "proof:drift-target"],
  ]) {
    await pool.query(
      `INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')`,
      [id, identity],
    );
  }
  for (const id of [proposerId, approverId]) {
    await pool.query(`INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`, [
      id,
      ownerRoleId,
    ]);
    await pool.query(
      `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
       VALUES ($1, $2, 'GLOBAL', NULL)`,
      [randomUUID(), id],
    );
  }
  await pool.query(`INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`, [
    scopedSupportId,
    supportRoleId,
  ]);
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'PLAYER', $3)`,
    [randomUUID(), scopedSupportId, allowedPlayerId],
  );

  try {
    await pool.query(
      `INSERT INTO admin_operations(
         id, principal_id, capability_key, operation_type, target_type, target_id, risk_tier,
         status, reason, expected_revision, idempotency_key, request_fingerprint, input,
         correlation_id, authorization_mode, requires_reason, requires_expected_revision
       ) VALUES (
         $1, $2, 'player.profile.edit', 'proof.invalid.reason', 'PLAYER', $3, 1,
         'DRAFT', NULL, NULL, $4, $5, '{}'::jsonb, $6, 'SUBJECT', TRUE, FALSE
       )`,
      [
        randomUUID(),
        proposerId,
        allowedPlayerId,
        `bad-reason-${randomUUID()}`,
        randomUUID(),
        randomUUID(),
      ],
    );
    throw new Error("Malformed requires_reason snapshot unexpectedly persisted");
  } catch (error) {
    expectCheckViolation(error);
  }
  try {
    await pool.query(
      `INSERT INTO admin_operations(
         id, principal_id, capability_key, operation_type, target_type, target_id, risk_tier,
         status, reason, expected_revision, idempotency_key, request_fingerprint, input,
         correlation_id, authorization_mode, requires_reason, requires_expected_revision
       ) VALUES (
         $1, $2, 'player.profile.edit', 'proof.invalid.revision', 'PLAYER', $3, 1,
         'DRAFT', 'proof reason', NULL, $4, $5, '{}'::jsonb, $6, 'SUBJECT', TRUE, TRUE
       )`,
      [
        randomUUID(),
        proposerId,
        allowedPlayerId,
        `bad-revision-${randomUUID()}`,
        randomUUID(),
        randomUUID(),
      ],
    );
    throw new Error("Malformed requires_expected_revision snapshot unexpectedly persisted");
  } catch (error) {
    expectCheckViolation(error);
  }

  const repository = new PostgresAdminRepository(pool);
  const service = new AdminService(createPhase12AdminOperationRegistry(repository), repository);

  const allowed = await service.authorizeRead({
    principalId: scopedSupportId,
    operationType: "player.read",
    input: { playerId: allowedPlayerId },
  });
  if (allowed.id !== allowedPlayerId)
    throw new Error("Player-scoped read did not resolve expected target");

  try {
    await service.authorizeRead({
      principalId: scopedSupportId,
      operationType: "player.read",
      input: { playerId: otherPlayerId },
    });
    throw new Error("BOLA scope bypass unexpectedly succeeded");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.AUTHORIZATION_DENIED);
  }

  try {
    await service.authorizeRead({
      principalId: scopedSupportId,
      operationType: "player.read",
      input: { playerId: allowedPlayerId, status: "ACTIVE" },
    });
    throw new Error("Mass-assignment input unexpectedly succeeded");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.INVALID_INPUT);
  }

  try {
    await service.prepareMutation({
      principalId: scopedSupportId,
      operationType: "admin.role.assign",
      input: { principalId: targetAdminId, roleId: supportRoleId },
      reason: "attempt unauthorized role assignment",
      expectedRevision: 0,
      idempotencyKey: "phase12-proof-unauthorized",
      correlationId: randomUUID(),
    });
    throw new Error("Unauthorized high-risk operation unexpectedly prepared");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.AUTHORIZATION_DENIED);
  }

  const idempotencyKey = "phase12-proof-role-assign-001";
  const correlationId = randomUUID();
  const request = {
    principalId: proposerId,
    operationType: "admin.role.assign",
    input: { principalId: targetAdminId, roleId: supportRoleId },
    reason: "grant support role for operational proof",
    expectedRevision: 0,
    idempotencyKey,
    correlationId,
  };
  const prepared = await service.prepareMutation(request);
  if (prepared.replayed || prepared.operation.status !== "VALIDATED") {
    throw new Error("High-risk operation was not prepared in VALIDATED state");
  }
  const replay = await service.prepareMutation(request);
  if (!replay.replayed || replay.operation.id !== prepared.operation.id) {
    throw new Error("Duplicate admin operation did not replay same semantic claim");
  }
  try {
    await service.prepareMutation({
      ...request,
      input: { principalId: staleTargetId, roleId: supportRoleId },
    });
    throw new Error("Idempotency fingerprint mismatch unexpectedly succeeded");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT);
  }

  const persistedSnapshot = await pool.query<{
    authorization_mode: string;
    requires_reason: boolean;
    requires_expected_revision: boolean;
    requires_simulation: boolean;
    requires_confirmation: boolean;
    required_approvals: number;
  }>(
    `SELECT authorization_mode, requires_reason, requires_expected_revision,
            requires_simulation, requires_confirmation, required_approvals
     FROM admin_operations WHERE id = $1`,
    [prepared.operation.id],
  );
  const snapshotRow = persistedSnapshot.rows[0];
  if (
    snapshotRow?.authorization_mode !== "GLOBAL_ONLY" ||
    snapshotRow.requires_reason !== true ||
    snapshotRow.requires_expected_revision !== true ||
    snapshotRow.requires_simulation !== true ||
    snapshotRow.requires_confirmation !== true ||
    snapshotRow.required_approvals !== 1
  ) {
    throw new Error(
      `Admin policy snapshot was not fully persisted: ${JSON.stringify(snapshotRow)}`,
    );
  }

  const driftPrepared = await service.prepareMutation({
    principalId: proposerId,
    operationType: "admin.role.assign",
    input: { principalId: driftTargetId, roleId: supportRoleId },
    reason: "policy drift proof",
    expectedRevision: 0,
    idempotencyKey: "phase12-proof-policy-drift-001",
    correlationId: randomUUID(),
  });
  const changedPolicyRegistry = new AdminOperationRegistry().register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "admin.role.assign",
      capabilityKey: "admin.role.assign",
      riskTier: 4,
      authorizationMode: "GLOBAL_ONLY",
      policy: {
        version: 2,
        requiresReason: true,
        requiresExpectedRevision: true,
        requiresSimulation: true,
        requiresConfirmation: true,
        requiredApprovals: 2,
      },
      inputSchema: AdminRoleAssignInputSchema,
      target: (input) => ({ type: "ADMIN_PRINCIPAL", id: input.principalId }),
      simulate: (input) => repository.simulateRoleAssignment(input),
      apply: (context, input) =>
        repository.applyRoleAssignment(context.operation, context.actorPrincipalId, input),
    }),
  );
  try {
    await new AdminService(changedPolicyRegistry, repository).simulate(
      driftPrepared.operation.id,
      proposerId,
    );
    throw new Error("Policy drift unexpectedly changed an in-flight admin operation");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT);
  }

  const changedAuthorizationRegistry = new AdminOperationRegistry().register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "admin.role.assign",
      capabilityKey: "admin.role.assign",
      riskTier: 4,
      authorizationMode: "SUBJECT",
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
      simulate: (input) => repository.simulateRoleAssignment(input),
      apply: (context, input) =>
        repository.applyRoleAssignment(context.operation, context.actorPrincipalId, input),
    }),
  );
  try {
    await new AdminService(changedAuthorizationRegistry, repository).simulate(
      driftPrepared.operation.id,
      proposerId,
    );
    throw new Error("Authorization-mode drift unexpectedly changed an in-flight operation");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT);
  }

  const simulated = await service.simulate(prepared.operation.id, proposerId);
  if (simulated.status !== "PENDING_CONFIRMATION")
    throw new Error("Simulation did not enter confirmation gate");
  const confirmed = await service.confirm(prepared.operation.id, proposerId);
  if (confirmed.status !== "PENDING_APPROVAL")
    throw new Error("Confirmation did not enter approval gate");
  try {
    await service.approve(prepared.operation.id, proposerId, "self approve");
    throw new Error("Self approval unexpectedly succeeded");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.SELF_APPROVAL_FORBIDDEN);
  }
  const approved = await service.approve(
    prepared.operation.id,
    approverId,
    "independent R4 approval",
  );
  if (approved.status !== "READY")
    throw new Error("Independent approval did not make operation READY");
  const applied = await service.apply(prepared.operation.id, proposerId);
  if (applied.status !== "APPLIED") throw new Error("Role assignment did not apply");
  const appliedReplay = await service.apply(prepared.operation.id, proposerId);
  if (appliedReplay.id !== applied.id || appliedReplay.status !== "APPLIED") {
    throw new Error("Applied admin operation did not replay safely");
  }

  const targetState = await pool.query<{ revision: string; role_count: string }>(
    `SELECT principal.revision::text,
            count(relation.role_id)::text AS role_count
     FROM admin_principals principal
     LEFT JOIN admin_principal_roles relation
       ON relation.principal_id = principal.id AND relation.role_id = $2
     WHERE principal.id = $1
     GROUP BY principal.id`,
    [targetAdminId, supportRoleId],
  );
  if (targetState.rows[0]?.revision !== "1" || targetState.rows[0]?.role_count !== "1") {
    throw new Error(`Role assignment target state invalid: ${JSON.stringify(targetState.rows[0])}`);
  }
  const evidence = await pool.query<{
    changes: string;
    audits: string;
    confirmations: string;
    approvals: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM admin_operation_changes WHERE admin_operation_id = $1) AS changes,
       (SELECT count(*)::text FROM audit_events WHERE metadata->>'adminOperationId' = $1::text) AS audits,
       (SELECT count(*)::text FROM admin_operation_confirmations WHERE admin_operation_id = $1) AS confirmations,
       (SELECT count(*)::text FROM admin_operation_approvals WHERE admin_operation_id = $1 AND decision = 'APPROVED') AS approvals`,
    [prepared.operation.id],
  );
  const evidenceRow = evidence.rows[0];
  if (
    evidenceRow?.changes !== "1" ||
    evidenceRow.audits !== "1" ||
    evidenceRow.confirmations !== "1" ||
    evidenceRow.approvals !== "1"
  ) {
    throw new Error(`Admin evidence incomplete: ${JSON.stringify(evidenceRow)}`);
  }

  const stalePrepared = await service.prepareMutation({
    principalId: proposerId,
    operationType: "admin.role.assign",
    input: { principalId: staleTargetId, roleId: supportRoleId },
    reason: "stale revision proof",
    expectedRevision: 0,
    idempotencyKey: "phase12-proof-stale-001",
    correlationId: randomUUID(),
  });
  await service.simulate(stalePrepared.operation.id, proposerId);
  await service.confirm(stalePrepared.operation.id, proposerId);
  await service.approve(
    stalePrepared.operation.id,
    approverId,
    "approve stale proof before conflict",
  );
  await pool.query(`UPDATE admin_principals SET revision = revision + 1 WHERE id = $1`, [
    staleTargetId,
  ]);
  try {
    await service.apply(stalePrepared.operation.id, proposerId);
    throw new Error("Stale admin operation unexpectedly overwrote concurrent state");
  } catch (error) {
    expectAdminCode(error, ADMIN_ERROR_CODES.REVISION_CONFLICT);
  }
  const staleAssignment = await pool.query(
    `SELECT 1 FROM admin_principal_roles WHERE principal_id = $1 AND role_id = $2`,
    [staleTargetId, supportRoleId],
  );
  if (staleAssignment.rowCount !== 0)
    throw new Error("Stale operation mutated target despite CAS conflict");

  console.log(
    "Phase 12A admin registry proof complete: capability + object/property auth, full policy snapshot drift lock, convergent RBAC bundles, DB snapshot constraints, R4 simulation/confirmation/dual approval, CAS, idempotency and append-only evidence verified",
  );
} finally {
  await pool.end();
}
