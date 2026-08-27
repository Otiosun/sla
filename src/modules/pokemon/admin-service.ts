import {
  ApplyPokemonEffectInputSchema,
  ArchivePokemonInputSchema,
  CorrectPokemonHpInputSchema,
  CorrectPokemonProgressionInputSchema,
  CorrectPokemonStatusInputSchema,
  CreatePokemonInputSchema,
  MovePokemonRosterInputSchema,
  type PokemonOwnerMutationResult,
  RemovePokemonEffectInputSchema,
} from "./admin-contracts.js";
import type { PokemonAdminPersistenceResult, PokemonAdminRepository } from "./admin-ports.js";
import type { PokemonEffectAdminRepository } from "./effect-admin-ports.js";
import type { PokemonLifecycleAdminRepository } from "./lifecycle-admin-ports.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

function translatePersistence(
  persisted: PokemonAdminPersistenceResult,
): Result<PokemonOwnerMutationResult> {
  switch (persisted.kind) {
    case "APPLIED":
      return ok(persisted.result);
    case "REPLAYED":
      return ok({ ...persisted.result, replayed: true });
    case "NOT_FOUND":
      return err(appError("NOT_FOUND", "Pokemon administrative target was not found"));
    case "REVISION_CONFLICT":
      return err(
        appError("REVISION_CONFLICT", "Pokemon aggregate revision changed", {
          actualRevision: persisted.actualRevision.toString(),
        }),
      );
    case "ACTIVE_BATTLE":
      return err(
        appError(
          "INVALID_STATE_TRANSITION",
          "Pokemon cannot be administratively mutated while referenced by an active battle",
        ),
      );
    case "TARGET_OCCUPIED":
      return err(appError("ACTION_INVALID", "Requested roster slot is already occupied"));
    case "INVALID_STATE":
      return err(appError("ACTION_INVALID", persisted.reason));
    case "IDEMPOTENCY_CONFLICT":
      return err(
        appError(
          "FINGERPRINT_MISMATCH",
          "Pokemon admin idempotency key is bound to another request",
        ),
      );
  }
}

export class PokemonAdminService {
  public constructor(
    private readonly repository: PokemonAdminRepository,
    private readonly effectRepository?: PokemonEffectAdminRepository,
    private readonly lifecycleRepository?: PokemonLifecycleAdminRepository,
  ) {}

  private effects(): PokemonEffectAdminRepository | null {
    return this.effectRepository ?? null;
  }

  private lifecycle(): PokemonLifecycleAdminRepository | null {
    return this.lifecycleRepository ?? null;
  }

  public async createPokemon(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = CreatePokemonInputSchema.safeParse(input);
    if (!parsed.success)
      return err(appError("VALIDATION_FAILED", "Invalid Pokemon create request"));
    const repository = this.lifecycle();
    if (repository === null) {
      return err(appError("FEATURE_UNAVAILABLE", "Pokemon creation administration is unavailable"));
    }
    return translatePersistence(await repository.createPokemon(parsed.data));
  }

  public async correctProgression(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = CorrectPokemonProgressionInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(appError("VALIDATION_FAILED", "Invalid Pokemon progression correction"));
    }
    const repository = this.lifecycle();
    if (repository === null) {
      return err(
        appError("FEATURE_UNAVAILABLE", "Pokemon progression administration is unavailable"),
      );
    }
    return translatePersistence(await repository.correctProgression(parsed.data));
  }

  public async moveRoster(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = MovePokemonRosterInputSchema.safeParse(input);
    if (!parsed.success) return err(appError("VALIDATION_FAILED", "Invalid Pokemon roster move"));
    return translatePersistence(await this.repository.moveRoster(parsed.data));
  }

  public async correctHp(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = CorrectPokemonHpInputSchema.safeParse(input);
    if (!parsed.success) return err(appError("VALIDATION_FAILED", "Invalid Pokemon HP correction"));
    return translatePersistence(await this.repository.correctHp(parsed.data));
  }

  public async correctStatus(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = CorrectPokemonStatusInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(appError("VALIDATION_FAILED", "Invalid Pokemon status correction"));
    }
    return translatePersistence(await this.repository.correctStatus(parsed.data));
  }

  public async applyEffect(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = ApplyPokemonEffectInputSchema.safeParse(input);
    if (!parsed.success) return err(appError("VALIDATION_FAILED", "Invalid Pokemon effect apply"));
    const repository = this.effects();
    if (repository === null) {
      return err(appError("FEATURE_UNAVAILABLE", "Pokemon effect administration is unavailable"));
    }
    return translatePersistence(await repository.applyEffect(parsed.data));
  }

  public async removeEffect(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = RemovePokemonEffectInputSchema.safeParse(input);
    if (!parsed.success)
      return err(appError("VALIDATION_FAILED", "Invalid Pokemon effect removal"));
    const repository = this.effects();
    if (repository === null) {
      return err(appError("FEATURE_UNAVAILABLE", "Pokemon effect administration is unavailable"));
    }
    return translatePersistence(await repository.removeEffect(parsed.data));
  }

  public async archivePokemon(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = ArchivePokemonInputSchema.safeParse(input);
    if (!parsed.success)
      return err(appError("VALIDATION_FAILED", "Invalid Pokemon archive request"));
    return translatePersistence(await this.repository.archivePokemon(parsed.data));
  }
}
