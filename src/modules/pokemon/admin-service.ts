import {
  ArchivePokemonInputSchema,
  CorrectPokemonHpInputSchema,
  CorrectPokemonStatusInputSchema,
  MovePokemonRosterInputSchema,
  type PokemonOwnerMutationResult,
} from "./admin-contracts.js";
import type { PokemonAdminPersistenceResult, PokemonAdminRepository } from "./admin-ports.js";
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
      return err(appError("NOT_FOUND", "Pokemon instance was not found for this player"));
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
  public constructor(private readonly repository: PokemonAdminRepository) {}

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

  public async archivePokemon(input: unknown): Promise<Result<PokemonOwnerMutationResult>> {
    const parsed = ArchivePokemonInputSchema.safeParse(input);
    if (!parsed.success) return err(appError("VALIDATION_FAILED", "Invalid Pokemon archive request"));
    return translatePersistence(await this.repository.archivePokemon(parsed.data));
  }
}
