import { z } from "zod";
import { ExternalIdentitySchema, type ExternalIdentity } from "../player/contracts.js";
import type { PlayerOnboardingRepository } from "../player/ports.js";
import { parsePokemonInstanceId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

const TeamPlacementSchema = z
  .object({
    placementKind: z.literal("TEAM"),
    boxNo: z.null(),
    slotNo: z.number().int().min(1).max(6),
  })
  .strict();

const BoxPlacementSchema = z
  .object({
    placementKind: z.literal("BOX"),
    boxNo: z.number().int().positive(),
    slotNo: z.number().int().positive(),
  })
  .strict();

const RosterMoveInputSchema = z
  .object({
    pokemonInstanceId: z.string().uuid(),
    target: z.discriminatedUnion("placementKind", [TeamPlacementSchema, BoxPlacementSchema]),
  })
  .strict();

export type PlayerPortalRosterMoveInput = z.infer<typeof RosterMoveInputSchema>;

export class PlayerPortalRosterService {
  public constructor(private readonly repository: PlayerOnboardingRepository) {}

  public async move(
    identity: ExternalIdentity,
    input: unknown,
  ): Promise<Result<void>> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    const parsedInput = RosterMoveInputSchema.safeParse(input);
    if (!parsedIdentity.success || !parsedInput.success) {
      return err(appError("VALIDATION_FAILED", "Invalid roster placement request"));
    }

    const pokemonInstanceId = parsePokemonInstanceId(parsedInput.data.pokemonInstanceId);
    if (!pokemonInstanceId.ok) {
      return err(appError("VALIDATION_FAILED", "Invalid Pokemon instance"));
    }

    return this.repository.transaction(async (transaction) => {
      const playerId = await transaction.findPlayerByIdentity(parsedIdentity.data);
      if (playerId === null) {
        return err(appError("NOT_FOUND", "Player portal profile unavailable"));
      }

      const profile = await transaction.loadProfileView(playerId);
      if (profile === null) {
        return err(appError("NOT_FOUND", "Player portal profile unavailable"));
      }
      if (profile.playerStatus !== "ACTIVE") {
        return err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access"));
      }

      const moved = await transaction.moveOwnedPokemon({
        playerId,
        pokemonInstanceId: pokemonInstanceId.value,
        target: parsedInput.data.target,
      });
      if (!moved) {
        return err(appError("NOT_FOUND", "Owned Pokemon unavailable"));
      }

      return ok(undefined);
    });
  }
}
