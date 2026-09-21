import { z } from "zod";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { type ExternalIdentity, ExternalIdentitySchema } from "../player/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";

const NullableShortText = (max: number) => z.string().trim().min(1).max(max).nullable();

export const PlayerPortalProfileCustomizationSchema = z
  .object({
    title: NullableShortText(60),
    bio: NullableShortText(500),
    appearance: NullableShortText(500),
    age: z.number().int().min(1).max(150).nullable(),
    height: NullableShortText(32),
    accent: z.enum(["teal", "gold", "violet", "crimson", "blue"]),
  })
  .strict();

export type PlayerPortalProfileCustomization = z.infer<
  typeof PlayerPortalProfileCustomizationSchema
>;

export const DEFAULT_PLAYER_PORTAL_PROFILE_CUSTOMIZATION: PlayerPortalProfileCustomization = {
  title: null,
  bio: null,
  appearance: null,
  age: null,
  height: null,
  accent: "crimson",
};

export interface PlayerPortalProfileCustomizationRepository {
  read(playerId: PlayerId): Promise<PlayerPortalProfileCustomization>;
  update(playerId: PlayerId, customization: PlayerPortalProfileCustomization): Promise<boolean>;
}

interface PlayerPortalProfileCustomizationDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly profiles: Pick<PlayerStarterService, "getProfile">;
  readonly repository: PlayerPortalProfileCustomizationRepository;
}

export class PlayerPortalProfileCustomizationService {
  public constructor(private readonly dependencies: PlayerPortalProfileCustomizationDependencies) {}

  public async update(
    identity: ExternalIdentity,
    input: unknown,
  ): Promise<Result<PlayerPortalProfileCustomization>> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    const parsedInput = PlayerPortalProfileCustomizationSchema.safeParse(input);
    if (!parsedIdentity.success || !parsedInput.success) {
      return err(appError("VALIDATION_FAILED", "Invalid Hub profile customization"));
    }

    const resolved = await this.dependencies.players.resolvePlayer(parsedIdentity.data);
    if (!resolved.ok) return resolved;

    const profile = await this.dependencies.profiles.getProfile(resolved.value.playerId);
    if (!profile.ok) return profile;
    if (profile.value.playerStatus !== "ACTIVE" || profile.value.onboardingState !== "COMPLETE") {
      return err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access"));
    }

    const updated = await this.dependencies.repository.update(
      resolved.value.playerId,
      parsedInput.data,
    );
    if (!updated) {
      return err(appError("NOT_FOUND", "Player profile was not found"));
    }

    return ok(parsedInput.data);
  }
}
