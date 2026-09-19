import { z } from "zod";
import { parsePokemonInstanceId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { type ExternalIdentity, ExternalIdentitySchema } from "../player/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";
import type { PokemonPcStorageService } from "../world-services/pc-storage-service.js";

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
    slotNo: z.number().int().min(1).max(30),
  })
  .strict();

const RosterMoveInputSchema = z
  .object({
    pokemonInstanceId: z.string().uuid(),
    target: z.discriminatedUnion("placementKind", [TeamPlacementSchema, BoxPlacementSchema]),
  })
  .strict();

export type PlayerPortalRosterMoveInput = z.infer<typeof RosterMoveInputSchema>;

interface PlayerPortalRosterDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly profiles: Pick<PlayerStarterService, "getProfile">;
  readonly storage: Pick<PokemonPcStorageService, "move">;
}

export class PlayerPortalRosterService {
  public constructor(private readonly dependencies: PlayerPortalRosterDependencies) {}

  public async move(identity: ExternalIdentity, input: unknown): Promise<Result<void>> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    const parsedInput = RosterMoveInputSchema.safeParse(input);
    if (!parsedIdentity.success || !parsedInput.success) {
      return err(appError("VALIDATION_FAILED", "Invalid roster placement request"));
    }

    const pokemonInstanceId = parsePokemonInstanceId(parsedInput.data.pokemonInstanceId);
    if (!pokemonInstanceId.ok) {
      return err(appError("VALIDATION_FAILED", "Invalid Pokemon instance"));
    }

    const resolved = await this.dependencies.players.resolvePlayer(parsedIdentity.data);
    if (!resolved.ok) return resolved;

    const profile = await this.dependencies.profiles.getProfile(resolved.value.playerId);
    if (!profile.ok) return profile;
    if (profile.value.playerStatus !== "ACTIVE" || profile.value.onboardingState !== "COMPLETE") {
      return err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access"));
    }

    const moved = await this.dependencies.storage.move({
      playerId: resolved.value.playerId,
      pokemonInstanceId: pokemonInstanceId.value,
      target: parsedInput.data.target,
    });
    if (!moved.ok) return moved;
    return ok(undefined);
  }
}
