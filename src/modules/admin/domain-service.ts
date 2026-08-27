import type { EconomyService } from "../economy/service.js";
import type { PokemonAdminService } from "../pokemon/admin-service.js";
import type { ProgressionService } from "../progression/service.js";
import { parsePlayerId, type PlayerId } from "../../shared-kernel/ids.js";
import type { AppError } from "../../shared-kernel/result.js";
import type { AdminOperationRecord } from "./contracts.js";
import type {
  AdminInventoryAdjustInput,
  AdminPokemonArchiveInput,
  AdminPokemonCreateInput,
  AdminPokemonEffectApplyInput,
  AdminPokemonEffectRemoveInput,
  AdminPokemonHpCorrectInput,
  AdminPokemonProgressCorrectInput,
  AdminPokemonRosterMoveInput,
  AdminPokemonStatusCorrectInput,
  AdminTrainerProgressAdjustInput,
  AdminWalletAdjustInput,
} from "./domain-contracts.js";
import type { AdminDomainOperationPort } from "./domain-ports.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminOperationCompletionPort } from "./ports.js";

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) {
    throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid player id");
  }
  return parsed.value;
}

function requiredReason(operation: AdminOperationRecord): string {
  if (operation.reason === null || operation.reason.trim().length === 0) {
    throw new AdminError(
      ADMIN_ERROR_CODES.REASON_REQUIRED,
      "Admin domain mutation requires reason",
    );
  }
  return operation.reason;
}

function requiredExpectedRevision(operation: AdminOperationRecord): bigint {
  if (operation.expectedRevision === null) {
    throw new AdminError(
      ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
      "Pokemon admin mutation requires expected revision",
    );
  }
  return operation.expectedRevision;
}

function ownerError(error: AppError): AdminError {
  if (error.code === "IDEMPOTENCY_KEY_INVALID" || error.code === "FINGERPRINT_MISMATCH") {
    return new AdminError(ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, error.message, error.details);
  }
  if (error.code === "REVISION_CONFLICT") {
    return new AdminError(ADMIN_ERROR_CODES.REVISION_CONFLICT, error.message, error.details);
  }
  if (error.code === "NOT_FOUND") {
    return new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, error.message, error.details);
  }
  if (error.code === "VALIDATION_FAILED" || error.code === "INVALID_ID") {
    return new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, error.message, error.details);
  }
  return new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, error.message, {
    ownerCode: error.code,
    ...(error.details ?? {}),
  });
}

function assertPlayerTarget(operation: AdminOperationRecord, targetPlayerId: string): void {
  if (operation.targetType !== "PLAYER" || operation.targetId !== targetPlayerId) {
    throw new AdminError(
      ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
      "Admin operation target no longer matches domain input",
    );
  }
}

export class AdminDomainOperationService implements AdminDomainOperationPort {
  public constructor(
    private readonly economy: EconomyService,
    private readonly progression: ProgressionService,
    private readonly completion: AdminOperationCompletionPort,
    private readonly pokemon?: PokemonAdminService,
  ) {}

  private pokemonOwner(): PokemonAdminService {
    if (this.pokemon === undefined) {
      throw new AdminError(
        ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
        "Pokemon administrative owner is unavailable",
      );
    }
    return this.pokemon;
  }

  private async completePokemonMutation(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    pokemonInstanceId: string,
    value: {
      readonly operationKind: string;
      readonly beforeRevision: string | null;
      readonly afterRevision: string;
      readonly beforeData: Readonly<Record<string, unknown>>;
      readonly afterData: Readonly<Record<string, unknown>>;
      readonly replayed: boolean;
    },
  ): Promise<AdminOperationRecord> {
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "POKEMON_INSTANCE",
      resourceId: pokemonInstanceId,
      beforeData: value.beforeData,
      afterData: value.afterData,
      result: {
        operationKind: value.operationKind,
        beforeRevision: value.beforeRevision,
        afterRevision: value.afterRevision,
        ownerReplayed: value.replayed,
      },
    });
  }

  public async applyInventoryAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminInventoryAdjustInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const delta = BigInt(input.delta);
    const quantity = delta < 0n ? -delta : delta;
    const result =
      delta > 0n
        ? await this.economy.addItem({
            playerId: playerId(input.playerId),
            itemId: input.itemId,
            quantity,
            idempotencyKey: operation.id,
            metadata: {
              sourceType: "ADMIN_OPERATION",
              sourceId: operation.id,
              reason: requiredReason(operation),
              actorType: "ADMIN",
              actorId: operation.principalId,
              correlationId: operation.correlationId,
            },
          })
        : await this.economy.consumeItem({
            playerId: playerId(input.playerId),
            itemId: input.itemId,
            quantity,
            idempotencyKey: operation.id,
            metadata: {
              sourceType: "ADMIN_OPERATION",
              sourceId: operation.id,
              reason: requiredReason(operation),
              actorType: "ADMIN",
              actorId: operation.principalId,
              correlationId: operation.correlationId,
            },
          });
    if (!result.ok) throw ownerError(result.error);

    const after = result.value.quantity;
    const before = after - delta;
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "PLAYER_INVENTORY_ITEM",
      resourceId: input.itemId,
      beforeData: {
        playerId: input.playerId,
        itemId: input.itemId,
        quantity: before.toString(),
      },
      afterData: {
        playerId: input.playerId,
        itemId: input.itemId,
        quantity: after.toString(),
      },
      result: {
        delta: delta.toString(),
        balanceAfter: after.toString(),
        ledgerId: result.value.ledgerId,
        ownerReplayed: result.value.replayed,
      },
    });
  }

  public async applyTrainerProgressAdjustment(
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

  public async applyWalletAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminWalletAdjustInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const delta = BigInt(input.delta);
    const amount = delta < 0n ? -delta : delta;
    const result =
      delta > 0n
        ? await this.economy.creditWallet({
            playerId: playerId(input.playerId),
            currencyId: input.currencyId,
            amount,
            idempotencyKey: operation.id,
            metadata: {
              sourceType: "ADMIN_OPERATION",
              sourceId: operation.id,
              reason: requiredReason(operation),
              actorType: "ADMIN",
              actorId: operation.principalId,
              correlationId: operation.correlationId,
            },
          })
        : await this.economy.debitWallet({
            playerId: playerId(input.playerId),
            currencyId: input.currencyId,
            amount,
            idempotencyKey: operation.id,
            metadata: {
              sourceType: "ADMIN_OPERATION",
              sourceId: operation.id,
              reason: requiredReason(operation),
              actorType: "ADMIN",
              actorId: operation.principalId,
              correlationId: operation.correlationId,
            },
          });
    if (!result.ok) throw ownerError(result.error);

    const after = result.value.amount;
    const before = after - delta;
    return this.completion.completeAppliedOperation({
      operation,
      actorPrincipalId,
      resourceType: "PLAYER_WALLET_CURRENCY",
      resourceId: input.currencyId,
      beforeData: {
        playerId: input.playerId,
        currencyId: input.currencyId,
        amount: before.toString(),
      },
      afterData: {
        playerId: input.playerId,
        currencyId: input.currencyId,
        amount: after.toString(),
      },
      result: {
        delta: delta.toString(),
        balanceAfter: after.toString(),
        ledgerId: result.value.ledgerId,
        ownerReplayed: result.value.replayed,
      },
    });
  }

  private pokemonMetadata(operation: AdminOperationRecord) {
    return {
      sourceType: "ADMIN_OPERATION" as const,
      sourceId: operation.id,
      reason: requiredReason(operation),
      actorType: "ADMIN" as const,
      actorId: operation.principalId,
    };
  }

  public async applyPokemonCreate(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonCreateInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.pokemonOwner().createPokemon({
      ...input,
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: this.pokemonMetadata(operation),
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completePokemonMutation(
      operation,
      actorPrincipalId,
      result.value.pokemonInstanceId,
      result.value,
    );
  }

  public async applyPokemonProgressCorrection(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonProgressCorrectInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.pokemonOwner().correctProgress({
      playerId: input.playerId,
      pokemonInstanceId: input.pokemonInstanceId,
      deltaXp: Number(BigInt(input.deltaXp)),
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: this.pokemonMetadata(operation),
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completePokemonMutation(
      operation,
      actorPrincipalId,
      input.pokemonInstanceId,
      result.value,
    );
  }

  public async applyPokemonRosterMove(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonRosterMoveInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.pokemonOwner().moveRoster({
      ...input,
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: this.pokemonMetadata(operation),
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completePokemonMutation(
      operation,
      actorPrincipalId,
      input.pokemonInstanceId,
      result.value,
    );
  }

  public async applyPokemonHpCorrection(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonHpCorrectInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.pokemonOwner().correctHp({
      ...input,
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: this.pokemonMetadata(operation),
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completePokemonMutation(
      operation,
      actorPrincipalId,
      input.pokemonInstanceId,
      result.value,
    );
  }

  public async applyPokemonStatusCorrection(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonStatusCorrectInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.pokemonOwner().correctStatus({
      ...input,
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: this.pokemonMetadata(operation),
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completePokemonMutation(
      operation,
      actorPrincipalId,
      input.pokemonInstanceId,
      result.value,
    );
  }

  public async applyPokemonEffect(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonEffectApplyInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.pokemonOwner().applyEffect({
      ...input,
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: this.pokemonMetadata(operation),
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completePokemonMutation(
      operation,
      actorPrincipalId,
      input.pokemonInstanceId,
      result.value,
    );
  }

  public async removePokemonEffect(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonEffectRemoveInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.pokemonOwner().removeEffect({
      ...input,
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: this.pokemonMetadata(operation),
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completePokemonMutation(
      operation,
      actorPrincipalId,
      input.pokemonInstanceId,
      result.value,
    );
  }

  public async applyPokemonArchive(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonArchiveInput,
  ): Promise<AdminOperationRecord> {
    assertPlayerTarget(operation, input.playerId);
    const result = await this.pokemonOwner().archivePokemon({
      ...input,
      expectedRevision: requiredExpectedRevision(operation),
      idempotencyKey: operation.id,
      correlationId: operation.correlationId,
      metadata: this.pokemonMetadata(operation),
    });
    if (!result.ok) throw ownerError(result.error);
    return this.completePokemonMutation(
      operation,
      actorPrincipalId,
      input.pokemonInstanceId,
      result.value,
    );
  }
}
