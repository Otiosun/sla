import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface HealPokemonCenterTeamInput {
  readonly playerId: PlayerId;
  readonly sessionId: string;
  readonly sourceInboxMessageId: string;
  readonly correlationId: string;
}

export interface PokemonCenterHealingChanges {
  readonly healedPokemonCount: number;
  readonly hpRestoredPokemonCount: number;
  readonly ppRestoredSlots: number;
  readonly statusesCleared: number;
}

export interface PokemonCenterHealingResult extends PokemonCenterHealingChanges {
  readonly replayed: boolean;
}

export type PokemonCenterHealingPersistenceResult =
  | { readonly kind: "APPLIED"; readonly result: PokemonCenterHealingChanges }
  | { readonly kind: "REPLAYED"; readonly result: PokemonCenterHealingChanges }
  | { readonly kind: "ACTIVE_BATTLE" }
  | { readonly kind: "ACTIVE_ENCOUNTER" }
  | { readonly kind: "CENTER_VISIT_REQUIRED" }
  | { readonly kind: "INVALID_STATE"; readonly reason: string };

export interface PokemonCenterHealingRepository {
  healTeam(input: HealPokemonCenterTeamInput): Promise<PokemonCenterHealingPersistenceResult>;
}

export class PokemonCenterHealingService {
  public constructor(private readonly repository: PokemonCenterHealingRepository) {}

  public async healTeam(
    input: HealPokemonCenterTeamInput,
  ): Promise<Result<PokemonCenterHealingResult>> {
    const result = await this.repository.healTeam(input);
    switch (result.kind) {
      case "APPLIED":
        return ok({ ...result.result, replayed: false });
      case "REPLAYED":
        return ok({ ...result.result, replayed: true });
      case "ACTIVE_BATTLE":
        return err(
          appError("ACTION_INVALID", "A Pokémon Center cannot heal a team during an active battle"),
        );
      case "ACTIVE_ENCOUNTER":
        return err(
          appError(
            "ACTION_INVALID",
            "A Pokémon Center cannot heal a team during an active encounter",
          ),
        );
      case "CENTER_VISIT_REQUIRED":
        return err(appError("ACTION_INVALID", "An active Pokémon Center visit is required"));
      case "INVALID_STATE":
        return err(appError("INVALID_STATE_TRANSITION", result.reason));
    }
  }
}
