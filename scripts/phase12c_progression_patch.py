from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"anchor missing: {path}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


# Candidate migration 0013 is unmerged, so extend it in place.
migration = Path("db/migrations/0013_domain_admin_operation_integrity.sql")
text = migration.read_text()
if "ADD COLUMN ruleset_id UUID" not in text:
    text += """
ALTER TABLE trainer_progress_ledger
  ADD COLUMN ruleset_id UUID NULL REFERENCES rulesets(id),
  ADD COLUMN result JSONB NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object');

COMMENT ON COLUMN trainer_progress_ledger.ruleset_id IS
  'Ruleset used to derive trainer level/unlocks for an operational progression adjustment; legacy rows may be NULL.';
COMMENT ON COLUMN trainer_progress_ledger.result IS
  'Durable result snapshot for exact idempotent replay of trainer progression mutations; legacy rows may be NULL.';
"""
    migration.write_text(text)

contracts = Path("src/modules/progression/contracts.ts")
text = contracts.read_text()
if "AdjustTrainerProgressInputSchema" not in text:
    anchor = "export const ApplyBattleRewardInputSchema = z\n"
    block = '''const signedSafeDelta = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => value !== 0, "delta must be non-zero");
const progressionSourceToken = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const AdjustTrainerProgressInputSchema = z
  .object({
    playerId: uuid,
    delta: signedSafeDelta,
    idempotencyKey,
    correlationId: uuid,
    metadata: z
      .object({
        sourceType: progressionSourceToken,
        sourceId: z.string().trim().min(1).max(255),
        reason: z.string().trim().min(1).max(512),
        actorType: z.enum(["SYSTEM", "ADMIN"]),
        actorId: uuid.nullable(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.actorType === "SYSTEM" && value.actorId !== null) {
          context.addIssue({ code: "custom", path: ["actorId"], message: "SYSTEM adjustment must not carry actorId" });
        }
        if (value.actorType === "ADMIN" && value.actorId === null) {
          context.addIssue({ code: "custom", path: ["actorId"], message: "ADMIN adjustment requires actorId" });
        }
      }),
  })
  .strict();
export type AdjustTrainerProgressInput = z.infer<typeof AdjustTrainerProgressInputSchema>;

export const TrainerProgressAdjustmentResultSchema = z
  .object({
    playerId: uuid,
    delta: signedSafeDelta,
    beforePoints: safeNonNegative,
    afterPoints: safeNonNegative,
    beforeLevel: z.number().int().min(1).max(100),
    afterLevel: z.number().int().min(1).max(100),
    rulesetId: uuid,
    activatedUnlockKeys: z.array(z.string().min(1).max(96)),
    revokedUnlockKeys: z.array(z.string().min(1).max(96)),
    replayed: z.boolean(),
  })
  .strict();
export type TrainerProgressAdjustmentResult = z.infer<typeof TrainerProgressAdjustmentResultSchema>;

'''
    if anchor not in text:
        raise SystemExit("progression contracts anchor missing")
    contracts.write_text(text.replace(anchor, block + anchor, 1))

replace_once(
    "src/modules/progression/errors.ts",
    '  | "PROGRESSION_IDEMPOTENCY_CONFLICT"\n',
    '  | "PROGRESSION_IDEMPOTENCY_CONFLICT"\n  | "TRAINER_PROGRESSION_NOT_FOUND"\n  | "TRAINER_PROGRESSION_UNDERFLOW"\n',
)

ports = Path("src/modules/progression/ports.ts")
text = ports.read_text()
if "TrainerProgressAdjustmentPersistenceResult" not in text:
    text = text.replace("  ApplyBattleRewardInput,\n", "  AdjustTrainerProgressInput,\n  ApplyBattleRewardInput,\n", 1)
    text = text.replace("  ResolveMoveChoiceInput,\n", "  ResolveMoveChoiceInput,\n  TrainerProgressAdjustmentResult,\n", 1)
    union = '''export type TrainerProgressAdjustmentPersistenceResult =
  | { readonly kind: "APPLIED"; readonly result: TrainerProgressAdjustmentResult }
  | { readonly kind: "REPLAYED"; readonly result: TrainerProgressAdjustmentResult }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "UNDERFLOW" }
  | { readonly kind: "RULES_MISSING" }
  | { readonly kind: "STATE_INVALID"; readonly reason: string }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

'''
    text = text.replace("export type BattleRewardPersistenceResult =\n", union + "export type BattleRewardPersistenceResult =\n", 1)
    text = text.replace(
        "export interface ProgressionRepository {\n",
        "export interface ProgressionRepository {\n  adjustTrainerProgress(input: AdjustTrainerProgressInput): Promise<TrainerProgressAdjustmentPersistenceResult>;\n",
        1,
    )
    ports.write_text(text)

service = Path("src/modules/progression/service.ts")
text = service.read_text()
if "adjustTrainerProgress(" not in text:
    text = text.replace("  ApplyBattleRewardInputSchema,\n", "  AdjustTrainerProgressInputSchema,\n  ApplyBattleRewardInputSchema,\n", 1)
    text = text.replace("  type MoveChoiceResult,\n", "  type MoveChoiceResult,\n  type TrainerProgressAdjustmentResult,\n", 1)
    anchor = "  public async resolveMoveChoice(input: unknown): Promise<ProgressionResult<MoveChoiceResult>> {\n"
    method = '''  public async adjustTrainerProgress(
    input: unknown,
  ): Promise<ProgressionResult<TrainerProgressAdjustmentResult>> {
    const parsed = AdjustTrainerProgressInputSchema.safeParse(input);
    if (!parsed.success)
      return progressionFailure("PROGRESSION_INPUT_INVALID", "Invalid trainer progression adjustment");
    const persisted = await this.repository.adjustTrainerProgress(parsed.data);
    switch (persisted.kind) {
      case "APPLIED":
        return { ok: true, value: persisted.result };
      case "REPLAYED":
        return { ok: true, value: { ...persisted.result, replayed: true } };
      case "NOT_FOUND":
        return progressionFailure("TRAINER_PROGRESSION_NOT_FOUND", "Player was not found");
      case "UNDERFLOW":
        return progressionFailure(
          "TRAINER_PROGRESSION_UNDERFLOW",
          "Trainer progression points cannot become negative",
        );
      case "RULES_MISSING":
        return progressionFailure(
          "PROGRESSION_RULES_MISSING",
          "Active ruleset has no trainer progression policy",
        );
      case "STATE_INVALID":
        return progressionFailure("PROGRESSION_STATE_INVALID", persisted.reason);
      case "IDEMPOTENCY_CONFLICT":
        return progressionFailure(
          "PROGRESSION_IDEMPOTENCY_CONFLICT",
          "Idempotency key is already bound to another trainer progression adjustment",
        );
    }
  }

'''
    if anchor not in text:
        raise SystemExit("progression service anchor missing")
    service.write_text(text.replace(anchor, method + anchor, 1))

repo = Path("src/platform/progression/postgres-progression-repository.ts")
text = repo.read_text()
if "adjustTrainerProgress(" not in text:
    text = text.replace("  type ApplyBattleRewardInput,\n", "  type AdjustTrainerProgressInput,\n  type ApplyBattleRewardInput,\n", 1)
    text = text.replace("  type TrainerProgressResult,\n", "  TrainerProgressAdjustmentResultSchema,\n  type TrainerProgressResult,\n", 1)
    text = text.replace("  ProgressionRepository,\n", "  ProgressionRepository,\n  TrainerProgressAdjustmentPersistenceResult,\n", 1)
    anchor = "  public async resolveMoveChoice(\n"
    method = r'''  public async adjustTrainerProgress(
    input: AdjustTrainerProgressInput,
  ): Promise<TrainerProgressAdjustmentPersistenceResult> {
    const storageKey = hashParts("progression.trainer-adjust", input.idempotencyKey.trim());
    try {
      return await withTransaction(this.pool, async (client) => {
        await acquireLocks(client, [
          `progression:trainer-adjust-key:${storageKey}`,
          `progression:trainer:${input.playerId}`,
        ]);

        const existing = await client.query<{
          player_id: string;
          delta: string;
          source_type: string;
          source_id: string;
          reason: string | null;
          actor_type: string;
          actor_id: string | null;
          ruleset_id: string | null;
          result: unknown;
        }>(
          `SELECT player_id, delta::text, source_type, source_id, reason, actor_type, actor_id,
                  ruleset_id, result
           FROM trainer_progress_ledger
           WHERE idempotency_scope = 'progression.trainer-adjust' AND idempotency_key = $1
           FOR UPDATE`,
          [storageKey],
        );
        const replay = existing.rows[0];
        if (replay !== undefined) {
          const compatible =
            replay.player_id === input.playerId &&
            safeInteger(replay.delta, "trainer progress ledger delta") === input.delta &&
            replay.source_type === input.metadata.sourceType &&
            replay.source_id === input.metadata.sourceId &&
            replay.reason === input.metadata.reason &&
            replay.actor_type === input.metadata.actorType &&
            replay.actor_id === input.metadata.actorId;
          if (!compatible) return { kind: "IDEMPOTENCY_CONFLICT" };
          if (replay.ruleset_id === null || replay.result === null) {
            return {
              kind: "STATE_INVALID",
              reason: "Trainer adjustment replay lacks durable result metadata",
            };
          }
          const parsed = TrainerProgressAdjustmentResultSchema.parse(replay.result);
          if (parsed.rulesetId !== replay.ruleset_id) {
            return {
              kind: "STATE_INVALID",
              reason: "Trainer adjustment result ruleset drifted from ledger",
            };
          }
          return { kind: "REPLAYED", result: { ...parsed, replayed: true } };
        }

        const player = await client.query<{ status: string }>(
          `SELECT status FROM players WHERE id = $1`,
          [input.playerId],
        );
        const playerRow = player.rows[0];
        if (playerRow === undefined) return { kind: "NOT_FOUND" };
        if (playerRow.status !== "ACTIVE") {
          return {
            kind: "STATE_INVALID",
            reason: `Player status ${playerRow.status} cannot receive progression adjustment`,
          };
        }

        const activeRules = await client.query<{ ruleset_id: string; config: unknown }>(
          `SELECT release.default_ruleset_id AS ruleset_id, ruleset.config
           FROM content_release_pointers pointer
           JOIN content_releases release ON release.id = pointer.content_release_id
           JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
           WHERE pointer.pointer_key = 'ACTIVE'
             AND release.status = 'PUBLISHED'
             AND ruleset.status = 'PUBLISHED'
           FOR SHARE OF pointer, release, ruleset`,
        );
        const activeRow = activeRules.rows[0];
        if (activeRow === undefined) return { kind: "RULES_MISSING" };
        const config = parseRulesetConfig(activeRow.config);
        const progression = config.progression;
        if (progression === undefined) return { kind: "RULES_MISSING" };

        await client.query(
          `INSERT INTO trainer_progression(player_id) VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
          [input.playerId],
        );
        const current = await client.query<{ level: number; progression_points: string }>(
          `SELECT level, progression_points::text
           FROM trainer_progression WHERE player_id = $1 FOR UPDATE`,
          [input.playerId],
        );
        const currentRow = current.rows[0];
        if (currentRow === undefined) {
          throw new ProgressionStateViolation("Trainer progression row is unavailable");
        }
        const beforePoints = safeInteger(currentRow.progression_points, "trainer progression_points");
        const afterPoints = beforePoints + input.delta;
        if (!Number.isSafeInteger(afterPoints)) {
          return {
            kind: "STATE_INVALID",
            reason: "Trainer progression points overflow JS safe range",
          };
        }
        if (afterPoints < 0) return { kind: "UNDERFLOW" };
        const afterLevel = trainerLevelForPoints(
          afterPoints,
          progression.trainer.levelCap,
          progression.trainer.levelCurve,
        );
        const updated = await client.query(
          `UPDATE trainer_progression
           SET progression_points = $2, level = $3, revision = revision + 1, updated_at = now()
           WHERE player_id = $1`,
          [input.playerId, afterPoints, afterLevel],
        );
        if (updated.rowCount !== 1) {
          throw new ProgressionStateViolation("Trainer progression adjustment update failed");
        }

        const activatedUnlockKeys: string[] = [];
        const revokedUnlockKeys: string[] = [];
        for (const unlock of progression.trainer.unlocks) {
          const currentUnlock = await client.query<{ status: string }>(
            `SELECT status FROM trainer_unlocks
             WHERE player_id = $1 AND unlock_key = $2 FOR UPDATE`,
            [input.playerId, unlock.unlockKey],
          );
          const unlockRow = currentUnlock.rows[0];
          if (afterLevel >= unlock.level) {
            if (unlockRow === undefined) {
              await client.query(
                `INSERT INTO trainer_unlocks(
                   player_id, unlock_key, source_type, source_id, status, unlocked_at, revoked_at
                 ) VALUES ($1, $2, 'TRAINER_PROGRESSION', $3, 'ACTIVE', now(), NULL)`,
                [input.playerId, unlock.unlockKey, input.metadata.sourceId],
              );
              activatedUnlockKeys.push(unlock.unlockKey);
            } else if (unlockRow.status === "REVOKED") {
              await client.query(
                `UPDATE trainer_unlocks
                 SET status = 'ACTIVE', source_type = 'TRAINER_PROGRESSION', source_id = $3,
                     unlocked_at = now(), revoked_at = NULL, revision = revision + 1
                 WHERE player_id = $1 AND unlock_key = $2 AND status = 'REVOKED'`,
                [input.playerId, unlock.unlockKey, input.metadata.sourceId],
              );
              activatedUnlockKeys.push(unlock.unlockKey);
            }
          } else if (unlockRow?.status === "ACTIVE") {
            await client.query(
              `UPDATE trainer_unlocks
               SET status = 'REVOKED', source_type = 'TRAINER_PROGRESSION', source_id = $3,
                   revoked_at = now(), revision = revision + 1
               WHERE player_id = $1 AND unlock_key = $2 AND status = 'ACTIVE'`,
              [input.playerId, unlock.unlockKey, input.metadata.sourceId],
            );
            revokedUnlockKeys.push(unlock.unlockKey);
          }
        }

        const result = TrainerProgressAdjustmentResultSchema.parse({
          playerId: input.playerId,
          delta: input.delta,
          beforePoints,
          afterPoints,
          beforeLevel: currentRow.level,
          afterLevel,
          rulesetId: activeRow.ruleset_id,
          activatedUnlockKeys,
          revokedUnlockKeys,
          replayed: false,
        });
        const ledger = await client.query(
          `INSERT INTO trainer_progress_ledger(
             id, player_id, delta, source_type, source_id, reason, actor_type, actor_id,
             idempotency_scope, idempotency_key, correlation_id, ruleset_id, result
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                     'progression.trainer-adjust', $9, $10, $11, $12::jsonb)`,
          [
            randomUUID(),
            input.playerId,
            input.delta,
            input.metadata.sourceType,
            input.metadata.sourceId,
            input.metadata.reason,
            input.metadata.actorType,
            input.metadata.actorId,
            storageKey,
            input.correlationId,
            activeRow.ruleset_id,
            JSON.stringify(result),
          ],
        );
        if (ledger.rowCount !== 1) {
          throw new ProgressionStateViolation("Trainer progression adjustment ledger claim failed");
        }
        return { kind: "APPLIED", result };
      });
    } catch (error) {
      if (error instanceof ProgressionStateViolation) {
        return { kind: "STATE_INVALID", reason: error.message };
      }
      throw error;
    }
  }

'''
    if anchor not in text:
        raise SystemExit("postgres progression insertion anchor missing")
    repo.write_text(text.replace(anchor, method + anchor, 1))

admin_contracts = Path("src/modules/admin/domain-contracts.ts")
text = admin_contracts.read_text()
if "AdminTrainerProgressAdjustInputSchema" not in text:
    text += '''
const safeSignedProgressDeltaSchema = z
  .string()
  .regex(/^-?[1-9][0-9]*$/)
  .refine((value) => {
    try {
      const parsed = BigInt(value);
      return parsed >= BigInt(-Number.MAX_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
    } catch {
      return false;
    }
  }, "trainer progression delta must fit the safe integer range and be non-zero");

export const AdminTrainerProgressAdjustInputSchema = z
  .object({ playerId: uuidSchema, delta: safeSignedProgressDeltaSchema })
  .strict();
export type AdminTrainerProgressAdjustInput = z.infer<typeof AdminTrainerProgressAdjustInputSchema>;
'''
    admin_contracts.write_text(text)

admin_ports = Path("src/modules/admin/domain-ports.ts")
text = admin_ports.read_text()
if "AdminTrainerProgressAdjustInput" not in text:
    text = text.replace(
        'import type { AdminInventoryAdjustInput, AdminWalletAdjustInput } from "./domain-contracts.js";',
        'import type { AdminInventoryAdjustInput, AdminTrainerProgressAdjustInput, AdminWalletAdjustInput } from "./domain-contracts.js";',
    )
    text = text.replace(
        "  applyWalletAdjustment(\n",
        "  applyTrainerProgressAdjustment(\n    operation: AdminOperationRecord,\n    actorPrincipalId: string,\n    input: AdminTrainerProgressAdjustInput,\n  ): Promise<AdminOperationRecord>;\n  applyWalletAdjustment(\n",
        1,
    )
    admin_ports.write_text(text)

admin_definitions = Path("src/modules/admin/domain-definitions.ts")
text = admin_definitions.read_text()
if 'operationType: "progression.trainer.adjust"' not in text:
    text = text.replace("  AdminInventoryAdjustInputSchema,\n", "  AdminInventoryAdjustInputSchema,\n  AdminTrainerProgressAdjustInputSchema,\n", 1)
    text = text.replace("  type AdminInventoryAdjustInput,\n", "  type AdminInventoryAdjustInput,\n  type AdminTrainerProgressAdjustInput,\n", 1)
    anchor = "  registry.register(\n    defineAdminOperation<AdminWalletAdjustInput>({\n"
    block = '''  registry.register(
    defineAdminOperation<AdminTrainerProgressAdjustInput>({
      kind: "MUTATION",
      operationType: "progression.trainer.adjust",
      capabilityKey: "progression.adjust",
      riskTier: 2,
      authorizationMode: "SUBJECT",
      policy: deltaPolicy,
      inputSchema: AdminTrainerProgressAdjustInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyTrainerProgressAdjustment(context.operation, context.actorPrincipalId, input),
    }),
  );

'''
    if anchor not in text:
        raise SystemExit("admin definitions anchor missing")
    admin_definitions.write_text(text.replace(anchor, block + anchor, 1))

admin_service = Path("src/modules/admin/domain-service.ts")
text = admin_service.read_text()
if "applyTrainerProgressAdjustment" not in text:
    text = text.replace(
        'import type { EconomyService } from "../economy/service.js";\n',
        'import type { EconomyService } from "../economy/service.js";\nimport type { ProgressionService } from "../progression/service.js";\n',
        1,
    )
    text = text.replace(
        'import type { AdminInventoryAdjustInput, AdminWalletAdjustInput } from "./domain-contracts.js";',
        'import type { AdminInventoryAdjustInput, AdminTrainerProgressAdjustInput, AdminWalletAdjustInput } from "./domain-contracts.js";',
    )
    text = text.replace(
        "    private readonly economy: EconomyService,\n    private readonly completion: AdminOperationCompletionPort,\n",
        "    private readonly economy: EconomyService,\n    private readonly progression: ProgressionService,\n    private readonly completion: AdminOperationCompletionPort,\n",
        1,
    )
    anchor = "  public async applyWalletAdjustment(\n"
    method = '''  public async applyTrainerProgressAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminTrainerProgressAdjustInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.progression.adjustTrainerProgress({
      playerId: input.playerId,
      delta: Number(BigInt(input.delta)),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: {
        sourceType: "ADMIN_OPERATION",
        sourceId: operation.id,
        reason: requiredReason(operation),
        actorType: "ADMIN",
        actorId: operation.principalId,
      },
    });
    if (!result.ok) {
      if (result.error.code === "PROGRESSION_IDEMPOTENCY_CONFLICT") {
        throw new AdminError(ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, result.error.message);
      }
      if (result.error.code === "TRAINER_PROGRESSION_NOT_FOUND") {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, result.error.message);
      }
      if (result.error.code === "PROGRESSION_INPUT_INVALID") {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, result.error.message);
      }
      throw new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, result.error.message, {
        ownerCode: result.error.code,
      });
    }
    const value = result.value;
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "TRAINER_PROGRESSION",
      resourceId: input.playerId,
      beforeData: {
        playerId: input.playerId,
        progressionPoints: value.beforePoints.toString(),
        level: value.beforeLevel,
      },
      afterData: {
        playerId: input.playerId,
        progressionPoints: value.afterPoints.toString(),
        level: value.afterLevel,
      },
      result: {
        delta: value.delta.toString(),
        rulesetId: value.rulesetId,
        activatedUnlockKeys: value.activatedUnlockKeys,
        revokedUnlockKeys: value.revokedUnlockKeys,
        ownerReplayed: value.replayed,
      },
    });
  }

'''
    if anchor not in text:
        raise SystemExit("admin domain service anchor missing")
    admin_service.write_text(text.replace(anchor, method + anchor, 1))

proof = Path("db/proofs/phase12_domain_admin_e2e.ts")
text = proof.read_text()
if 'operationType: "progression.trainer.adjust"' not in text:
    text = text.replace(
        'import { EconomyService } from "../../src/modules/economy/service.js";\n',
        'import { EconomyService } from "../../src/modules/economy/service.js";\nimport { ProgressionService } from "../../src/modules/progression/service.js";\n',
        1,
    )
    text = text.replace(
        'import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";\n',
        'import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";\nimport { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";\n',
        1,
    )
    text = text.replace(
        "  const economy = new EconomyService(new PostgresEconomyRepository(pool));\n",
        "  const economy = new EconomyService(new PostgresEconomyRepository(pool));\n  const progression = new ProgressionService(new PostgresProgressionRepository(pool));\n",
        1,
    )
    text = text.replace(
        "    new AdminDomainOperationService(economy, completion),\n",
        "    new AdminDomainOperationService(economy, progression, completion),\n",
        1,
    )
    marker = '  console.log(\n    "Phase 12C domain admin proof complete:'
    idx = text.find(marker)
    if idx < 0:
        raise SystemExit("domain proof completion marker missing")
    scenarios = r'''  const trainerUp = await admin.prepareMutation({
    principalId,
    operationType: "progression.trainer.adjust",
    input: { playerId, delta: "900" },
    reason: "Restore missing trainer progression",
    idempotencyKey: `phase12c-trainer-up-${playerId}`,
    correlationId: randomUUID(),
  });
  const trainerApplied = await admin.apply(trainerUp.operation.id, principalId);
  if (trainerApplied.status !== "APPLIED") throw new Error("Trainer progression admin adjustment failed");
  const trainerState = await pool.query<{ level: number; progression_points: string }>(
    `SELECT level, progression_points::text FROM trainer_progression WHERE player_id = $1`,
    [playerId],
  );
  const tournament = await pool.query<{ status: string }>(
    `SELECT status FROM trainer_unlocks WHERE player_id = $1 AND unlock_key = 'tournament.eligible'`,
    [playerId],
  );
  if (
    trainerState.rows[0]?.progression_points !== "900" ||
    trainerState.rows[0]?.level !== 10 ||
    tournament.rows[0]?.status !== "ACTIVE"
  ) {
    throw new Error("Trainer progression threshold activation is inconsistent");
  }

  const trainerDown = await admin.prepareMutation({
    principalId,
    operationType: "progression.trainer.adjust",
    input: { playerId, delta: "-200" },
    reason: "Correct excess trainer progression",
    idempotencyKey: `phase12c-trainer-down-${playerId}`,
    correlationId: randomUUID(),
  });
  await admin.apply(trainerDown.operation.id, principalId);
  const trainerAfterDown = await pool.query<{ level: number; progression_points: string }>(
    `SELECT level, progression_points::text FROM trainer_progression WHERE player_id = $1`,
    [playerId],
  );
  const tournamentAfterDown = await pool.query<{ status: string; revoked_at: Date | null }>(
    `SELECT status, revoked_at FROM trainer_unlocks WHERE player_id = $1 AND unlock_key = 'tournament.eligible'`,
    [playerId],
  );
  if (
    trainerAfterDown.rows[0]?.progression_points !== "700" ||
    trainerAfterDown.rows[0]?.level !== 8 ||
    tournamentAfterDown.rows[0]?.status !== "REVOKED" ||
    tournamentAfterDown.rows[0]?.revoked_at === null
  ) {
    throw new Error("Trainer progression downward correction did not revoke derived unlock");
  }

  const underflow = await admin.prepareMutation({
    principalId,
    operationType: "progression.trainer.adjust",
    input: { playerId, delta: "-800" },
    reason: "Invalid underflow probe",
    idempotencyKey: `phase12c-trainer-underflow-${playerId}`,
    correlationId: randomUUID(),
  });
  let underflowRejected = false;
  try {
    await admin.apply(underflow.operation.id, principalId);
  } catch (error) {
    underflowRejected = error instanceof AdminError && error.code === "ADMIN_DOMAIN_OPERATION_REJECTED";
  }
  if (!underflowRejected) throw new Error("Trainer progression underflow was not rejected");
  const underflowLedger = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM trainer_progress_ledger
     WHERE idempotency_scope = 'progression.trainer-adjust' AND source_id = $1`,
    [underflow.operation.id],
  );
  if (underflowLedger.rows[0]?.count !== "0") {
    throw new Error("Rejected trainer underflow wrote a ledger row");
  }

  const crashTrainer = await admin.prepareMutation({
    principalId,
    operationType: "progression.trainer.adjust",
    input: { playerId, delta: "200" },
    reason: "Crash-window trainer adjustment",
    idempotencyKey: `phase12c-trainer-crash-${playerId}`,
    correlationId: randomUUID(),
  });
  const ownerCrash = await progression.adjustTrainerProgress({
    playerId,
    delta: 200,
    idempotencyKey: crashTrainer.operation.id,
    correlationId: crashTrainer.operation.correlationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: crashTrainer.operation.id,
      reason: "Crash-window trainer adjustment",
      actorType: "ADMIN",
      actorId: crashTrainer.operation.principalId,
    },
  });
  if (!ownerCrash.ok || ownerCrash.value.afterPoints !== 900 || ownerCrash.value.afterLevel !== 10) {
    throw new Error("Trainer crash-window owner mutation failed");
  }
  const interveningTrainer = await progression.adjustTrainerProgress({
    playerId,
    delta: 100,
    idempotencyKey: `intervening-${randomUUID()}`,
    correlationId: randomUUID(),
    metadata: {
      sourceType: "SYSTEM",
      sourceId: `phase12c-intervening-${playerId}`,
      reason: "Intervening progression mutation",
      actorType: "SYSTEM",
      actorId: null,
    },
  });
  if (!interveningTrainer.ok || interveningTrainer.value.afterPoints !== 1000) {
    throw new Error("Intervening trainer progression mutation failed");
  }
  const recoveredTrainer = await admin.apply(crashTrainer.operation.id, principalId);
  if (recoveredTrainer.status !== "APPLIED" || recoveredTrainer.result?.ownerReplayed !== true) {
    throw new Error("Trainer crash-window recovery did not replay owner result");
  }
  const trainerEvidence = await pool.query<{
    current_points: string;
    ledger_result: unknown;
    before_points: string | null;
    after_points: string | null;
  }>(
    `SELECT progression.progression_points::text AS current_points,
            ledger.result AS ledger_result,
            change.before_data ->> 'progressionPoints' AS before_points,
            change.after_data ->> 'progressionPoints' AS after_points
     FROM trainer_progression progression
     JOIN trainer_progress_ledger ledger
       ON ledger.source_id = $2::text AND ledger.idempotency_scope = 'progression.trainer-adjust'
     JOIN admin_operation_changes change ON change.admin_operation_id = $2
     WHERE progression.player_id = $1`,
    [playerId, crashTrainer.operation.id],
  );
  const trainerEvidenceRow = trainerEvidence.rows[0];
  const durableTrainerResult = trainerEvidenceRow?.ledger_result as { afterPoints?: number } | undefined;
  if (
    trainerEvidenceRow?.current_points !== "1000" ||
    durableTrainerResult?.afterPoints !== 900 ||
    trainerEvidenceRow.before_points !== "700" ||
    trainerEvidenceRow.after_points !== "900"
  ) {
    throw new Error("Trainer crash-window evidence is not stable");
  }

'''
    proof.write_text(text[:idx] + scenarios + text[idx:])

workflow = Path(".github/workflows/admin-proof.yml")
text = workflow.read_text()
if "Seed canonical progression rules for domain operations" not in text:
    anchor = "      - name: Run PostgreSQL Phase 12C Domain Admin E2E\n"
    block = '''      - name: Seed canonical progression rules for domain operations
        run: |
          pnpm db:seed:phase4
          pnpm db:seed:phase5
          pnpm db:seed:phase6
          pnpm db:seed:phase7
          pnpm db:seed:phase11

'''
    if anchor not in text:
        raise SystemExit("admin workflow domain proof anchor missing")
    workflow.write_text(text.replace(anchor, block + anchor, 1))
