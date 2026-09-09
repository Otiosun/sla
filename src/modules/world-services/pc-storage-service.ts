import type { PlayerId, PokemonInstanceId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface PokemonPcPokemonView {
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly displayName: string;
  readonly level: number;
  readonly placementKind: "TEAM" | "BOX";
  readonly boxNo: number | null;
  readonly slotNo: number;
}

export interface PokemonPcBoxView {
  readonly boxNo: number;
  readonly occupied: number;
  readonly capacity: 30;
  readonly pokemon: readonly PokemonPcPokemonView[];
}

export interface PokemonPcStorageSnapshot {
  readonly playerId: PlayerId;
  readonly team: readonly PokemonPcPokemonView[];
  readonly boxes: readonly PokemonPcBoxView[];
}

export interface DepositPokemonPcInput {
  readonly playerId: PlayerId;
  readonly pokemonInstanceId: PokemonInstanceId;
}

export interface WithdrawPokemonPcInput {
  readonly playerId: PlayerId;
  readonly pokemonInstanceId: PokemonInstanceId;
}

export interface OrganizePokemonPcInput {
  readonly playerId: PlayerId;
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly boxNo: number;
  readonly slotNo: number;
}

export interface PokemonPcDepositApplied {
  readonly kind: "APPLIED";
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly fromSlotNo: number;
  readonly boxNo: number;
  readonly slotNo: number;
}

export interface PokemonPcWithdrawApplied {
  readonly kind: "APPLIED";
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly fromBoxNo: number;
  readonly fromSlotNo: number;
  readonly teamSlotNo: number;
}

export interface PokemonPcOrganizeApplied {
  readonly kind: "APPLIED";
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly fromBoxNo: number;
  readonly fromSlotNo: number;
  readonly toBoxNo: number;
  readonly toSlotNo: number;
}

export type PokemonPcDepositPersistenceResult =
  | PokemonPcDepositApplied
  | { readonly kind: "LAST_TEAM_MEMBER" }
  | { readonly kind: "POKEMON_NOT_IN_TEAM" };

export type PokemonPcWithdrawPersistenceResult =
  | PokemonPcWithdrawApplied
  | { readonly kind: "TEAM_FULL" }
  | { readonly kind: "POKEMON_NOT_IN_BOX" };

export type PokemonPcOrganizePersistenceResult =
  | PokemonPcOrganizeApplied
  | { readonly kind: "DESTINATION_OCCUPIED" }
  | { readonly kind: "POKEMON_NOT_IN_BOX" }
  | { readonly kind: "INVALID_DESTINATION" };

export interface PokemonPcStorageRepository {
  loadStorage(playerId: PlayerId): Promise<PokemonPcStorageSnapshot>;
  deposit(input: DepositPokemonPcInput): Promise<PokemonPcDepositPersistenceResult>;
  withdraw(input: WithdrawPokemonPcInput): Promise<PokemonPcWithdrawPersistenceResult>;
  organize(input: OrganizePokemonPcInput): Promise<PokemonPcOrganizePersistenceResult>;
}

export class PokemonPcStorageService {
  public constructor(private readonly repository: PokemonPcStorageRepository) {}

  public async getStorage(playerId: PlayerId): Promise<Result<PokemonPcStorageSnapshot>> {
    return ok(await this.repository.loadStorage(playerId));
  }

  public async deposit(input: DepositPokemonPcInput): Promise<Result<PokemonPcDepositApplied>> {
    const result = await this.repository.deposit(input);
    switch (result.kind) {
      case "APPLIED":
        return ok(result);
      case "LAST_TEAM_MEMBER":
        return err(appError("ACTION_INVALID", "At least one Pokemon must remain in the team"));
      case "POKEMON_NOT_IN_TEAM":
        return err(appError("ACTION_INVALID", "The selected Pokemon is not in the active team"));
    }
  }

  public async withdraw(input: WithdrawPokemonPcInput): Promise<Result<PokemonPcWithdrawApplied>> {
    const result = await this.repository.withdraw(input);
    switch (result.kind) {
      case "APPLIED":
        return ok(result);
      case "TEAM_FULL":
        return err(appError("ACTION_INVALID", "The Pokemon team already has six members"));
      case "POKEMON_NOT_IN_BOX":
        return err(appError("ACTION_INVALID", "The selected Pokemon is not stored in a PC box"));
    }
  }

  public async organize(input: OrganizePokemonPcInput): Promise<Result<PokemonPcOrganizeApplied>> {
    if (!Number.isInteger(input.boxNo) || input.boxNo < 1 || !Number.isInteger(input.slotNo)) {
      return err(appError("VALIDATION_FAILED", "Pokemon PC destination is invalid"));
    }
    if (input.slotNo < 1 || input.slotNo > 30) {
      return err(appError("VALIDATION_FAILED", "Pokemon PC destination is invalid"));
    }

    const result = await this.repository.organize(input);
    switch (result.kind) {
      case "APPLIED":
        return ok(result);
      case "DESTINATION_OCCUPIED":
        return err(
          appError("ACTION_INVALID", "The destination Pokemon PC slot is already occupied"),
        );
      case "POKEMON_NOT_IN_BOX":
        return err(appError("ACTION_INVALID", "The selected Pokemon is not stored in a PC box"));
      case "INVALID_DESTINATION":
        return err(appError("VALIDATION_FAILED", "Pokemon PC destination is invalid"));
    }
  }
}
